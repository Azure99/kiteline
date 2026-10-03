import { agentLimits } from "../limits.js";
import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { AppError, asError, OperationError, type GitPath } from "@kiteline/shared/protocol";
import { BytePrefix } from "../buffers.js";
import { stopGroup, waitForGroup } from "../process-group.js";
import { JobChild, spawnJob } from "@kiteline/shared/windows/job";
import { windowsExecutable } from "../tools.js";

interface Options {
  input?: Buffer | string;
  onData?: (data: Buffer) => void;
  maxBytes?: number;
  truncate?: boolean;
  allowedCodes?: number[];
  env?: NodeJS.ProcessEnv;
  write?: boolean;
}
const repositoryEnvironment = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_NAMESPACE",
  "GIT_REFERENCE_BACKEND",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
]);
export async function git(
  root: string,
  args: string[],
  signal: AbortSignal,
  options: Options = {},
) {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env };
  for (const name of Object.keys(env))
    if (repositoryEnvironment.has(process.platform === "win32" ? name.toUpperCase() : name))
      delete env[name];
  const command = [
    "--no-pager",
    ...(options.write ? [] : ["--no-optional-locks", "-c", "color.ui=false"]),
    ...args,
  ];
  let child;
  try {
    const executable = process.platform === "win32" ? await windowsExecutable("git", env) : "git";
    signal.throwIfAborted();
    child =
      process.platform === "win32"
        ? await spawnJob(executable, command, { cwd: root, env })
        : spawn(executable, command, {
            cwd: root,
            detached: true,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
  } catch (error) {
    if (!options.write) throw error;
    const reason = asError(error);
    throw new OperationError(reason.code, reason.message, "failed");
  }
  const stdout = new BytePrefix(options.onData ? 0 : (options.maxBytes ?? agentLimits.resultBytes));
  const stderr = new BytePrefix(32 * 1024);
  let error: unknown;
  let clipped = false;
  let stopping: Promise<void> | undefined;
  let groupFailure = false;
  const groupError = (reason: unknown) => {
    error ??= reason;
    if (!groupFailure) console.error("Git process group:", asError(reason).message);
    groupFailure = true;
  };
  const stop = () => {
    if (child instanceof JobChild) {
      child.terminate();
      return;
    }
    if (child.pid && !stopping) {
      const pid = child.pid;
      stopping = stopGroup(
        pid,
        exited.then(() => waitForGroup(pid, groupError)),
        1000,
        groupError,
      );
    }
  };
  const abort = () => stop();
  signal.addEventListener("abort", abort, { once: true });
  const exited =
    child instanceof JobChild
      ? child.exited.then((result) => result.code)
      : new Promise<number | null>((resolve) => {
          child.on("error", (reason) => {
            error ??= reason;
            if (!child.pid) resolve(null);
            else stop();
          });
          child.once("exit", (code) => {
            if (code === null) stop();
            resolve(code);
          });
        });
  child.stdin!.on("error", (reason: NodeJS.ErrnoException) => {
    if (reason.code !== "EPIPE") {
      error = reason;
      stop();
    }
  });
  child.stdout!.on("data", (chunk: Buffer) => {
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
  child.stderr!.on("data", (chunk: Buffer) => stderr.append(chunk));
  const output = Promise.all(
    [child.stdout!, child.stderr!].map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.once("end", resolve);
          stream.once("error", (reason) => {
            error ??= reason;
            stop();
          });
          stream.once("close", () => {
            if (!stream.readableEnded)
              error ??= new AppError("io_error", "Git output closed before EOF");
            resolve();
          });
        }),
    ),
  );
  if (options.input === undefined) child.stdin!.end();
  else child.stdin!.end(options.input);
  if (signal.aborted) stop();
  const code = await exited;
  if (child instanceof JobChild) await child.empty;
  const drainTimer = setTimeout(() => {
    if (!child.stdout!.readableEnded || !child.stderr!.readableEnded) {
      error ??= new AppError(
        "io_error",
        "Git output pipes did not close after the main process exited",
      );
      child.stdout!.destroy();
      child.stderr!.destroy();
    }
  }, 1000);
  try {
    await output;
  } finally {
    clearTimeout(drainTimer);
    signal.removeEventListener("abort", abort);
    child.stdin!.destroy();
  }
  // Cancellation or a stream error can start cleanup during output draining.
  await stopping;
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
export function gitPath(bytes: Buffer, old?: Buffer): GitPath {
  if (isUtf8(bytes) && (!old || isUtf8(old)))
    return { path: bytes.toString(), ...(old ? { oldPath: old.toString() } : {}) };
  const escaped = (value: Buffer) =>
    Array.from(value, (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  return { pathError: old ? `${escaped(old)} -> ${escaped(bytes)}` : escaped(bytes) };
}
export function gitPathKey(path: GitPath) {
  return JSON.stringify([path.path, path.oldPath, path.pathError]);
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
      if (end - start > agentLimits.resultBytes)
        throw new AppError("limit_exceeded", "A Git record exceeds the size limit");
      this.each(bytes.subarray(start, end));
      start = end + 1;
    }
    this.partial = Buffer.from(bytes.subarray(start));
    if (this.partial.length > agentLimits.resultBytes)
      throw new AppError("limit_exceeded", "A Git record exceeds the size limit");
  };
  end() {
    if (this.partial.length) throw new AppError("io_error", "Git record is incomplete");
  }
}
