import { agentLimits } from "../limits.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { AppError, asError, OperationError } from "@kiteline/shared/protocol";
import { BytePrefix } from "@kiteline/shared/node/buffers";
import { stopGroup, waitForGroup } from "../process-group.js";
import { JobChild, spawnJob } from "@kiteline/shared/windows/job";
import { windowsExecutable } from "../tools.js";

interface WriteOptions {
  input?: Buffer | string;
  env?: NodeJS.ProcessEnv;
}
interface ReadOptions extends WriteOptions {
  maxBytes?: number;
  onData?: (data: Buffer) => void;
  truncate?: boolean;
  allowedCodes?: number[];
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
const processGroupStopGraceMs = 1000;
const outputDrainTimeoutMs = 1000;
export async function gitRead(
  root: string,
  args: string[],
  signal: AbortSignal,
  options: ReadOptions = {},
) {
  const { stdout, stderr, code, error } = await runGit(root, args, signal, {
    kind: "read",
    options,
  });
  signal.throwIfAborted();
  if (error) throw error;
  if (!stdout.truncated && !(options.allowedCodes ?? [0]).includes(code ?? -1))
    throw new AppError("io_error", stderr.text().trim() || "Git command failed", {
      exitCode: code,
    });
  return {
    bytes: stdout.bytes,
    text: stdout.text(),
    stderr: stderr.text(),
    truncated: stdout.truncated || stderr.truncated,
    code,
  };
}

export async function gitWrite(
  root: string,
  args: string[],
  signal: AbortSignal,
  options: WriteOptions = {},
) {
  const { stdout, stderr, code, error, started } = await runGit(root, args, signal, {
    kind: "write",
    options,
  });
  const result = {
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: stdout.truncated || stderr.truncated,
  };
  if (signal.aborted || error || code !== 0) {
    const reason = asError(
      signal.aborted
        ? signal.reason
        : (error ?? new AppError("io_error", result.stderr.trim() || "Git command failed")),
    );
    throw OperationError.from(reason, started ? "unknown" : "failed", {
      ...result,
      exitCode: code,
    });
  }
  return result;
}

async function runGit(
  root: string,
  args: string[],
  signal: AbortSignal,
  request: { kind: "read"; options: ReadOptions } | { kind: "write"; options: WriteOptions },
) {
  const { options } = request;
  const readOptions = request.kind === "read" ? request.options : undefined;
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env };
  for (const name of Object.keys(env))
    if (repositoryEnvironment.has(process.platform === "win32" ? name.toUpperCase() : name))
      delete env[name];
  const command = [
    "--no-pager",
    ...(request.kind === "read" ? ["--no-optional-locks", "-c", "color.ui=false"] : []),
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
    if (request.kind === "read") throw error;
    const reason = asError(error);
    throw new OperationError(reason.code, reason.message, "failed");
  }
  const stdout = new BytePrefix(
    readOptions?.onData ? 0 : (readOptions?.maxBytes ?? agentLimits.resultBytes),
  );
  const stderr = new BytePrefix(32 * 1024);
  let error: unknown;
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
        processGroupStopGraceMs,
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
    if (error || stdout.truncated) return;
    try {
      if (readOptions?.onData) readOptions.onData(chunk);
      else {
        stdout.append(chunk);
        if (stdout.truncated && readOptions) {
          if (!readOptions.truncate)
            error = new AppError("limit_exceeded", "Git output exceeds the size limit");
          stop();
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
  }, outputDrainTimeoutMs);
  try {
    await output;
  } finally {
    clearTimeout(drainTimer);
    signal.removeEventListener("abort", abort);
    child.stdin!.destroy();
  }
  // Cancellation or a stream error can start cleanup during output draining.
  await stopping;
  return { stdout, stderr, code, error, started: !!child.pid };
}

export async function readAfterWrite<T>(known: object, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const reason = asError(error);
    throw new OperationError(
      reason.code,
      `Write completed, but the result could not be read: ${reason.message}`,
      "unknown",
      known,
    );
  }
}

export function gitProgressError(error: unknown, progressed: boolean, result: object) {
  return OperationError.from(
    asError(error),
    progressed ? "partial" : error instanceof OperationError ? error.outcome : "failed",
    {
      ...(error instanceof OperationError && typeof error.result === "object" ? error.result : {}),
      ...result,
    },
  );
}
export async function gitHash(root: string, args: string[], signal: AbortSignal) {
  const hash = createHash("sha256");
  await gitRead(root, args, signal, {
    onData: (chunk) => {
      hash.update(chunk);
    },
  });
  return hash.digest("hex");
}
