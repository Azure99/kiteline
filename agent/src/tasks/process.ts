import { taskLimits } from "../limits.js";
import { spawn, type ChildProcess } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { type TaskRun } from "@kiteline/shared/protocol";
import { stopGroup, waitForGroup } from "../process-group.js";
import { JobChild, spawnJob } from "@kiteline/shared/windows/job";

function diagnostic(error: unknown) {
  return Buffer.from(error instanceof Error ? error.message : String(error))
    .subarray(0, taskLimits.diagnosticBytes)
    .toString();
}

export class TaskProcess {
  readonly output: TaskRun["output"] = { stdoutBytes: 0, stderrBytes: 0, truncated: false };
  readonly done: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    diagnostic?: string;
  }>;
  readonly pid?: number;
  stopReason?: "requested_stop" | "agent_stop";
  private readonly groupDone: Promise<void>;
  private groupEnded = false;
  private lifecycleDiagnostic?: string;
  private stopping?: Promise<void>;

  static async start(
    shell: string,
    run: TaskRun,
    outputPath: (stream: "stdout" | "stderr") => string,
    reserveBytes: (wanted: number) => number,
    releaseBytes: (bytes: number) => void,
    outputLimit: number,
  ) {
    const child =
      process.platform === "win32"
        ? await spawnJob(
            shell,
            ["-NoProfile", "-NonInteractive", "-Command", run.parameters.command],
            {
              cwd: run.parameters.cwd,
              stdio: ["ignore", "pipe", "pipe"],
            },
          )
        : spawn(shell, ["-c", run.parameters.command], {
            cwd: run.parameters.cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    return new TaskProcess(child, outputPath, reserveBytes, releaseBytes, outputLimit);
  }

  private constructor(
    private readonly child: ChildProcess | JobChild,
    outputPath: (stream: "stdout" | "stderr") => string,
    private readonly reserveBytes: (wanted: number) => number,
    private readonly releaseBytes: (bytes: number) => void,
    private readonly outputLimit: number,
  ) {
    this.pid = child.pid;
    let failure: string | undefined;
    const exited =
      child instanceof JobChild
        ? child.exited.then((result) => ({ exitCode: result.code, signal: null }))
        : new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.on("error", (error) => {
              failure = diagnostic(error);
              if (!this.pid) resolve({ exitCode: null, signal: null });
            });
            child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
          });
    const output = Promise.all([
      this.drain(this.child.stdout!, "stdout", outputPath("stdout")),
      this.drain(this.child.stderr!, "stderr", outputPath("stderr")),
    ]);
    const groupDone = (async () => {
      await exited;
      if (child instanceof JobChild) await child.empty;
      else if (this.pid) await waitForGroup(this.pid, (error) => this.reportLifecycleError(error));
      this.groupEnded = true;
    })();
    this.groupDone = groupDone;
    this.done = (async () => {
      const result = await exited;
      await groupDone;
      await this.stopping;
      const timer = setTimeout(() => {
        if (!this.child.stdout!.readableEnded || !this.child.stderr!.readableEnded) {
          this.output.error ??= "Output pipes did not close after the process group ended";
          this.child.stdout!.destroy();
          this.child.stderr!.destroy();
        }
      }, 1000);
      try {
        await output;
      } finally {
        clearTimeout(timer);
      }
      return { ...result, diagnostic: failure ?? this.lifecycleDiagnostic };
    })();
  }

  stop(reason: "requested_stop" | "agent_stop") {
    if (this.groupEnded) return Promise.resolve();
    this.stopReason ??= reason;
    this.stopping ??= this.stopGroup();
    return this.stopping;
  }

  private async stopGroup() {
    if (!this.pid) return;
    if (this.child instanceof JobChild) {
      this.child.terminate();
      await this.groupDone;
      return;
    }
    await stopGroup(this.pid, this.groupDone, taskLimits.stopGraceMs, (error) =>
      this.reportLifecycleError(error),
    );
  }

  private reportLifecycleError(error: unknown) {
    if (!this.lifecycleDiagnostic) {
      this.lifecycleDiagnostic = diagnostic(error);
      console.error("Scheduled task process group:", this.lifecycleDiagnostic);
    }
  }

  private async drain(stream: Readable, name: "stdout" | "stderr", path: string) {
    let file: FileHandle | undefined;
    const key = name === "stdout" ? "stdoutBytes" : "stderrBytes";
    const opening = (async () => {
      try {
        file = await open(path, "wx", 0o600);
      } catch (error) {
        this.output.error ??= diagnostic(error);
      }
    })();
    // Subscribe before awaiting disk I/O: Node resumes unread pipes when a child exits.
    try {
      for await (const bytes of stream) {
        await opening;
        const chunk = Buffer.from(bytes as Uint8Array);
        if (!file || this.output.error) continue;
        const remaining = Math.max(
          0,
          this.outputLimit - this.output.stdoutBytes - this.output.stderrBytes,
        );
        const reserved = this.reserveBytes(Math.min(chunk.length, remaining));
        if (reserved < chunk.length) this.output.truncated = true;
        // Reserve before awaiting: stdout and stderr share both budgets.
        this.output[key] += reserved;
        let written = 0;
        try {
          while (written < reserved) {
            const part = await file.write(chunk, written, reserved - written, null);
            if (!part.bytesWritten) throw new Error("Output write made no progress");
            written += part.bytesWritten;
          }
        } catch (error) {
          this.output.error ??= diagnostic(error);
        } finally {
          this.output[key] -= reserved - written;
          this.releaseBytes(reserved - written);
        }
      }
    } catch (error) {
      this.output.error ??= diagnostic(error);
      stream.resume();
    } finally {
      try {
        await opening;
        await file?.close();
      } catch (error) {
        this.output.error ??= diagnostic(error);
      }
    }
  }
}
