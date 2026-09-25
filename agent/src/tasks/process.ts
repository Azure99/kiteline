import { spawn, type ChildProcess } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { taskLimits, type TaskRun } from "@kiteline/shared/protocol";
import { groupRunning } from "../process-group.js";

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
  private readonly child: ChildProcess;
  private readonly groupDone: Promise<void>;
  private groupEnded = false;
  private lifecycleDiagnostic?: string;
  private stopping?: Promise<void>;

  constructor(
    shell: string,
    run: TaskRun,
    outputPath: (stream: "stdout" | "stderr") => string,
    private readonly reserveBytes: (wanted: number) => number,
    private readonly releaseBytes: (bytes: number) => void,
    private readonly outputLimit: number,
  ) {
    this.child = spawn(shell, ["-c", run.parameters.command], {
      cwd: run.parameters.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pid = this.child.pid;
    let failure: string | undefined;
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        this.child.on("error", (error) => {
          failure = diagnostic(error);
          if (!this.pid) resolve({ exitCode: null, signal: null });
        });
        this.child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
      },
    );
    const output = Promise.all([
      this.drain(this.child.stdout!, "stdout", outputPath("stdout")),
      this.drain(this.child.stderr!, "stderr", outputPath("stderr")),
    ]);
    const groupDone = (async () => {
      await exited;
      let interval = 50;
      while (this.pid) {
        try {
          if (!(await groupRunning(this.pid))) break;
        } catch (error) {
          this.reportLifecycleError(error);
        }
        await delay(interval);
        interval = Math.min(interval * 2, 500);
      }
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
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-this.pid!, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.reportLifecycleError(error);
      }
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), taskLimits.stopGraceMs);
    try {
      await this.groupDone;
    } finally {
      clearTimeout(timer);
    }
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
    try {
      try {
        file = await open(path, "wx", 0o600);
      } catch (error) {
        this.output.error ??= diagnostic(error);
      }
      for await (const bytes of stream) {
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
        await file?.close();
      } catch (error) {
        this.output.error ??= diagnostic(error);
      }
    }
  }
}
