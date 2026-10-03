import { agentLimits } from "../limits.js";
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parserStream } from "stream-json";
import type { Token } from "stream-json/parser.js";
import { AppError, type SearchMatch, type SearchResult } from "@kiteline/shared/protocol";
import { SearchJson } from "./search-json.js";
import { gitMetadataPath } from "./paths.js";
import { BytePrefix } from "../buffers.js";
import { ripgrepBinary } from "../tools.js";
import { JobChild, spawnJob } from "@kiteline/shared/windows/job";
import { finished } from "node:stream/promises";

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
  if (process.platform === "win32") args.push("--path-separator", "/");
  args.push("--", ".");
  let child;
  try {
    child =
      process.platform === "win32"
        ? await spawnJob(ripgrepBinary, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(ripgrepBinary, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    signal.throwIfAborted();
    throw new AppError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "unsupported" : "io_error",
      `ripgrep could not start: ${String(error)}`,
    );
  }
  let spawnError: NodeJS.ErrnoException | undefined;
  if (!(child instanceof JobChild))
    child.on("error", (error) => {
      spawnError = error;
    });
  const exited =
    child instanceof JobChild
      ? child.exited.then((result) => result.code)
      : new Promise<number | null>((resolve) => child.once("close", resolve));
  const errorOutput =
    child instanceof JobChild
      ? finished(child.stderr!, { writable: false, cleanup: true }).catch((error) => {
          spawnError ??= error;
          stop();
        })
      : Promise.resolve();
  const stderr = new BytePrefix(agentLimits.searchErrorBytes);
  child.stderr!.on("data", (data: Buffer) => stderr.append(data));
  const controller = new AbortController();
  const result: SearchResult = { matches: [], truncated: false };
  let resultBytes = 64,
    limited = false;
  const stop = () => {
    if (child instanceof JobChild) child.terminate();
    else child.kill("SIGTERM");
    controller.abort();
  };
  const abort = () => {
    if (signal.reason instanceof AppError && signal.reason.code === "timeout") {
      limited = true;
      result.truncated = true;
    }
    stop();
  };
  let drainTimer: NodeJS.Timeout | undefined;
  const groupDone =
    child instanceof JobChild
      ? child.empty.then(() => {
          drainTimer = setTimeout(() => {
            if (!child.stdout!.readableEnded)
              child.stdout!.destroy(new Error("Search output did not close after its Job ended"));
            if (!child.stderr!.readableEnded)
              child.stderr!.destroy(new Error("Search output did not close after its Job ended"));
          }, 1000);
        })
      : Promise.resolve();
  signal.addEventListener("abort", abort, { once: true });
  const found = async (match: SearchMatch) => {
    const metadata = await gitMetadataPath(root, match.path);
    controller.signal.throwIfAborted();
    if (metadata) return;
    const bytes = Buffer.byteLength(JSON.stringify(match)) + 1;
    if (resultBytes + bytes <= agentLimits.resultBytes - 256) {
      result.matches.push(match);
      resultBytes += bytes;
      result.truncated ||= match.truncated === true;
    } else limited = true;
    if (result.matches.length >= agentLimits.searchMatches) limited = true;
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
        child.stdout!,
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
              Promise.resolve(reader.token(token)).then(() => callback(), callback);
            } catch (error) {
              callback(error as Error);
            }
          },
        }),
        { signal: controller.signal },
      );
    } else {
      let name = new BytePrefix(agentLimits.searchPathBytes);
      await pipeline(
        child.stdout!,
        new Writable({
          write(data: Buffer, _encoding, callback) {
            void (async () => {
              for (let start = 0; start < data.length; ) {
                controller.signal.throwIfAborted();
                const end = data.indexOf(0, start);
                name.append(data.subarray(start, end < 0 ? data.length : end));
                if (end < 0) break;
                if (name.truncated || !isUtf8(name.bytes)) result.truncated = true;
                else {
                  const path = name.bytes.toString().replace(/^\.\//, "");
                  if (path.includes(query)) await found({ path });
                }
                name = new BytePrefix(agentLimits.searchPathBytes);
                if (limited) break;
                start = end + 1;
              }
            })().then(() => callback(), callback);
          },
        }),
        { signal: controller.signal },
      );
    }
  } catch (error) {
    failure = error;
    stop();
  }
  const code = await exited;
  await groupDone;
  await errorOutput;
  clearTimeout(drainTimer);
  signal.removeEventListener("abort", abort);
  if (signal.aborted && !limited) throw signal.reason;
  if (spawnError)
    throw new AppError(
      spawnError.code === "ENOENT" ? "unsupported" : "io_error",
      spawnError.code === "ENOENT"
        ? "Bundled ripgrep is unavailable; rebuild native components or reinstall the matching agent package"
        : spawnError.message,
    );
  if (!limited && (failure || (code !== 0 && code !== 1)))
    throw new AppError("io_error", stderr.text().trim() || "Search could not be completed", {
      truncated: stderr.truncated,
    });
  return result;
}
