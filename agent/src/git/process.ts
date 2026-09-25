import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { AppError, asError, OperationError, limits } from "@kiteline/shared/protocol";
import { BytePrefix } from "../buffers.js";

interface Options {
  input?: Buffer | string;
  onData?: (data: Buffer) => void;
  maxBytes?: number;
  truncate?: boolean;
  allowedCodes?: number[];
  env?: NodeJS.ProcessEnv;
  write?: boolean;
}
export async function git(
  root: string,
  args: string[],
  signal: AbortSignal,
  options: Options = {},
) {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env };
  for (const name of [
    "GIT_LITERAL_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
  ])
    delete env[name];
  const child = spawn(
    "git",
    [
      "--no-pager",
      ...(options.write ? [] : ["--no-optional-locks", "-c", "color.ui=false"]),
      ...args,
    ],
    {
      cwd: root,
      detached: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = new BytePrefix(options.onData ? 0 : (options.maxBytes ?? limits.resultBytes));
  const stderr = new BytePrefix(32 * 1024);
  let error: unknown;
  let clipped = false;
  let killTimer: NodeJS.Timeout | undefined;
  let terminated: Promise<void> | undefined;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process group may already have exited.
      }
      terminated ??= new Promise<void>((resolve) => {
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* Already exited. */
          }
          resolve();
        }, 1000);
      });
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
          if (!options.write) {
            if (!options.truncate)
              error = new AppError("limit_exceeded", "Git output exceeds the size limit");
            stop();
          }
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
  if (terminated && child.pid) {
    let groupAlive = false;
    try {
      process.kill(-child.pid, 0);
      groupAlive = true;
    } catch {
      /* No remaining group. */
    }
    if (groupAlive) await terminated;
  }
  clearTimeout(killTimer);
  const result = {
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: clipped || stderr.truncated,
    exitCode: code,
  };
  if (
    options.write &&
    (signal.aborted || error || !(options.allowedCodes ?? [0]).includes(code ?? -1))
  ) {
    const reason = asError(
      signal.aborted
        ? signal.reason
        : (error ?? new AppError("io_error", stderr.text().trim() || "Git command failed")),
    );
    throw new OperationError(
      reason.code,
      reason.message,
      child.pid ? "unknown" : "failed",
      result,
      reason.details,
    );
  }
  signal.throwIfAborted();
  if (error) throw error;
  if (!clipped && !(options.allowedCodes ?? [0]).includes(code ?? -1))
    throw new AppError("io_error", stderr.text().trim() || "Git command failed", {
      exitCode: code,
    });
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
  if (!isUtf8(bytes))
    throw new AppError("unsupported", "Git path is not valid UTF-8; handle it in the terminal");
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
        throw new AppError("limit_exceeded", "A Git record exceeds the size limit");
      this.each(bytes.subarray(start, end));
      start = end + 1;
    }
    this.partial = Buffer.from(bytes.subarray(start));
    if (this.partial.length > limits.resultBytes)
      throw new AppError("limit_exceeded", "A Git record exceeds the size limit");
  };
  end() {
    if (this.partial.length) throw new AppError("io_error", "Git record is incomplete");
  }
}
