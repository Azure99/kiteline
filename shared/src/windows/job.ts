import { Socket } from "node:net";
import { windowsNative, type NativeHandle } from "./native.js";

export type JobStdio = "pipe" | "inherit" | "ignore";
export interface JobOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: [JobStdio, JobStdio, JobStdio];
}

function quote(value: string) {
  if (value.includes("\0")) throw new Error("Process arguments cannot contain NUL");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}
function environmentBlock(environment: NodeJS.ProcessEnv) {
  const values = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (key.includes("\0") || key.includes("=") || value.includes("\0"))
      throw new Error("Invalid process environment");
    values.set(key.toUpperCase(), [key, value]);
  }
  return (
    [...values.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, [key, value]]) => `${key}=${value}`)
      .join("\0") + "\0\0"
  );
}

export class JobChild {
  private resolveExit!: (result: { code: number }) => void;
  private rejectExit!: (error: unknown) => void;
  private resolveEmpty!: () => void;
  readonly exited = new Promise<{ code: number }>((resolve, reject) => {
    this.resolveExit = resolve;
    this.rejectExit = reject;
  });
  readonly empty = new Promise<void>((resolve) => {
    this.resolveEmpty = resolve;
  });
  private released = false;
  private stopping = false;
  private terminating = false;
  private observedCode?: number;
  private cleanupFailure?: unknown;

  get exitCode() {
    return this.observedCode;
  }
  get cleanupError() {
    return this.cleanupFailure;
  }

  private report(error: unknown) {
    if (this.cleanupFailure !== undefined) return;
    this.cleanupFailure = error;
    this.rejectExit(error);
    console.error("Windows Job cleanup failed; retaining process ownership:", error);
  }

  constructor(
    private readonly handle: NativeHandle,
    readonly pid: number,
    readonly stdin: Socket | undefined,
    readonly stdout: Socket | undefined,
    readonly stderr: Socket | undefined,
  ) {
    const native = windowsNative();
    // A failed observation never relinquishes the process set or resolves empty.
    void this.exited.catch(() => {});
    let observedEmpty = false;
    const timer = setInterval(() => {
      if (!observedEmpty && this.stopping) {
        try {
          this.terminate();
        } catch (error) {
          this.report(error);
        }
      }
      try {
        if (!observedEmpty) {
          const status = native.jobInspect(handle);
          if (status.code !== undefined) {
            this.observedCode = status.code;
            this.resolveExit({ code: status.code });
          }
          observedEmpty = status.active === 0 && status.code !== undefined;
        }
        if (observedEmpty) {
          native.jobRelease(handle);
          clearInterval(timer);
          this.released = true;
          this.resolveEmpty();
        }
      } catch (error) {
        if (!observedEmpty) this.stopping = true;
        this.report(error);
      }
    }, 10);
  }

  terminate() {
    if (this.released || this.terminating) return;
    this.stopping = true;
    try {
      windowsNative().jobTerminate(this.handle);
    } catch (error) {
      this.report(error);
      throw error;
    }
    this.terminating = true;
  }
}

export async function spawnJob(executable: string, args: string[], options: JobOptions = {}) {
  const native = windowsNative();
  const modes = options.stdio ?? ["pipe", "pipe", "pipe"];
  const child = native.jobStart(
    executable,
    [executable, ...args].map(quote).join(" "),
    options.cwd ?? "",
    environmentBlock(options.env ?? process.env),
    modes.map((mode) => ["pipe", "inherit", "ignore"].indexOf(mode)),
  );
  const streams: (Socket | undefined)[] = [];
  const unowned = new Set(child.fds.filter((fd) => fd >= 0));
  let job: JobChild | undefined;
  try {
    for (const [index, fd] of child.fds.entries()) {
      const stream =
        fd < 0 ? undefined : new Socket({ fd, readable: index !== 0, writable: index === 0 });
      unowned.delete(fd);
      streams.push(stream);
    }
    streams[0]?.on("error", () => {});
    job = new JobChild(child.handle, child.pid, streams[0], streams[1], streams[2]);
    native.jobResume(child.handle);
    return job;
  } catch (error) {
    job ??= new JobChild(child.handle, child.pid, streams[0], streams[1], streams[2]);
    const errors = [error];
    for (const stream of streams) stream?.destroy();
    for (const fd of unowned) {
      try {
        native.closeFd(fd);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    try {
      job.terminate();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    await job.empty;
    if (errors.length > 1)
      throw new AggregateError(errors, "Job startup and cleanup failed", { cause: error });
    throw error;
  }
}
