import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parserStream } from "stream-json";
import type { Token } from "stream-json/parser.js";
import { AppError, limits, type SearchMatch, type SearchResult } from "@kiteline/shared/protocol";
import { BytePrefix, SearchJson } from "./search-json.js";

export async function searchFiles(
  root: string,
  mode: "name" | "content",
  query: string,
  includeIgnored: boolean,
  signal: AbortSignal,
): Promise<SearchResult> {
  signal.throwIfAborted();
  const args =
    mode === "name"
      ? ["--no-config", "--files", "--hidden", "-0", "-g", "!.git"]
      : ["--no-config", "--json", "--hidden", "--fixed-strings", "-g", "!.git", "-e", query];
  if (includeIgnored) args.push("--no-ignore");
  args.push("--", ".");
  const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const stderr = new BytePrefix(limits.searchErrorBytes);
  child.stderr.on("data", (data: Buffer) => stderr.append(data));
  const controller = new AbortController();
  const result: SearchResult = { matches: [], truncated: false };
  let resultBytes = 64,
    limited = false;
  const stop = () => {
    child.kill("SIGTERM");
    controller.abort();
  };
  const abort = () => {
    if (signal.reason instanceof AppError && signal.reason.code === "timeout") {
      limited = true;
      result.truncated = true;
    }
    stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  const found = (match: SearchMatch) => {
    const bytes = Buffer.byteLength(JSON.stringify(match)) + 1;
    if (resultBytes + bytes <= limits.resultBytes - 256) {
      result.matches.push(match);
      resultBytes += bytes;
      result.truncated ||= match.truncated === true;
    } else limited = true;
    if (result.matches.length >= limits.searchMatches) limited = true;
    if (limited) {
      result.truncated = true;
      stop();
    }
  };
  let failure: unknown;
  try {
    if (signal.aborted) abort();
    if (mode === "content") {
      const reader = new SearchJson(found, () => {
        result.truncated = true;
      });
      await pipeline(
        child.stdout,
        parserStream({
          packStrings: false,
          packNumbers: false,
          streamKeys: false,
          jsonStreaming: true,
        }),
        new Writable({
          objectMode: true,
          write(token: Token, _encoding, callback) {
            try {
              reader.token(token);
              callback();
            } catch (error) {
              callback(error as Error);
            }
          },
        }),
        { signal: controller.signal },
      );
    } else {
      let name = new BytePrefix(limits.searchPathBytes);
      await pipeline(
        child.stdout,
        new Writable({
          write(data: Buffer, _encoding, callback) {
            for (let start = 0; start < data.length; ) {
              const end = data.indexOf(0, start);
              name.append(data.subarray(start, end < 0 ? data.length : end));
              if (end < 0) break;
              if (name.truncated || !isUtf8(name.bytes)) result.truncated = true;
              else {
                const path = name.bytes.toString().replace(/^\.\//, "");
                if (path.includes(query)) found({ path });
              }
              name = new BytePrefix(limits.searchPathBytes);
              if (limited) break;
              start = end + 1;
            }
            callback();
          },
        }),
        { signal: controller.signal },
      );
    }
  } catch (error) {
    failure = error;
    stop();
  }
  const code = await closed;
  signal.removeEventListener("abort", abort);
  if (signal.aborted && !limited) throw signal.reason;
  if (spawnError)
    throw new AppError(
      spawnError.code === "ENOENT" ? "unsupported" : "io_error",
      spawnError.code === "ENOENT" ? "设备未安装 ripgrep (rg)" : spawnError.message,
    );
  if (!limited && (failure || (code !== 0 && code !== 1)))
    throw new AppError("io_error", stderr.text().trim() || "搜索未能完成", {
      truncated: stderr.truncated,
    });
  return result;
}
