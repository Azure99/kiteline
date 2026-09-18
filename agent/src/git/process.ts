import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { AppError, limits } from "@kiteline/shared/protocol";
import { BytePrefix } from "../buffers.js";

interface Options {
  input?: Buffer | string;
  onData?: (data: Buffer) => void;
  maxBytes?: number;
  truncate?: boolean;
  allowedCodes?: number[];
  env?: NodeJS.ProcessEnv;
}
export async function git(
  root: string,
  args: string[],
  signal: AbortSignal,
  options: Options = {},
) {
  signal.throwIfAborted();
  const child = spawn(
    "git",
    ["--no-pager", "--literal-pathspecs", "--no-optional-locks", "-c", "color.ui=false", ...args],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = new BytePrefix(options.onData ? 0 : (options.maxBytes ?? limits.resultBytes));
  const stderr = new BytePrefix(32 * 1024);
  let error: unknown;
  let clipped = false;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process group may already have exited.
      }
    }
  };
  const abort = () => stop();
  signal.addEventListener("abort", abort, { once: true });
  child.on("error", (reason) => {
    error = reason;
  });
  child.stdin.on("error", (reason: NodeJS.ErrnoException) => {
    if (reason.code !== "EPIPE") {
      error = reason;
      stop();
    }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (error || clipped) return;
    try {
      if (options.onData) options.onData(chunk);
      else {
        stdout.append(chunk);
        if (stdout.truncated) {
          clipped = true;
          if (!options.truncate) error = new AppError("limit_exceeded", "Git 输出超过容量");
          stop();
        }
      }
    } catch (reason) {
      error = reason;
      stop();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  child.stdin.end(options.input);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  signal.removeEventListener("abort", abort);
  signal.throwIfAborted();
  if (error) throw error;
  if (!clipped && !(options.allowedCodes ?? [0]).includes(code ?? -1))
    throw new AppError("io_error", stderr.text().trim() || "Git 命令失败", { exitCode: code });
  return {
    bytes: stdout.bytes,
    text: stdout.text(),
    stderr: stderr.text(),
    truncated: clipped || stderr.truncated,
    code,
  };
}
export async function gitHash(root: string, args: string[], signal: AbortSignal) {
  const hash = createHash("sha256");
  await git(root, args, signal, {
    onData: (chunk) => {
      hash.update(chunk);
    },
  });
  return hash.digest("hex");
}
export function utf8(bytes: Buffer) {
  if (!isUtf8(bytes)) throw new AppError("unsupported", "Git 路径不是有效 UTF-8，需在终端处理");
  return bytes.toString();
}
export function commandLine(bytes: Buffer) {
  return utf8(bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes);
}
export class NulRecords {
  private partial = Buffer.alloc(0);
  constructor(private each: (record: Buffer) => void) {}
  data = (chunk: Buffer) => {
    const bytes = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let start = 0,
      end: number;
    while ((end = bytes.indexOf(0, start)) !== -1) {
      if (end - start > limits.resultBytes)
        throw new AppError("limit_exceeded", "Git 单条记录超过容量");
      this.each(bytes.subarray(start, end));
      start = end + 1;
    }
    this.partial = Buffer.from(bytes.subarray(start));
    if (this.partial.length > limits.resultBytes)
      throw new AppError("limit_exceeded", "Git 单条记录超过容量");
  };
  end() {
    if (this.partial.length) throw new AppError("io_error", "Git 记录不完整");
  }
}
