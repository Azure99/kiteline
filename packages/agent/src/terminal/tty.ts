import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { finished } from "node:stream/promises";
import { AppError, limits } from "@kiteline/shared/protocol";
import { JobChild, spawnJob } from "@kiteline/shared/windows/job";
import {
  msysPath,
  ptyBridgeBinary,
  tmuxAttachArgs,
  tmuxBinary,
  tmuxEnvironment,
} from "@kiteline/shared/terminal/node";

const frameHeaderBytes = 5;
const frameLengthOffset = 1;
const resizePayloadBytes = 4;
const resizeColsOffset = 0;
const resizeRowsOffset = 2;
// Give the helper's 1000ms stop/drain phase time before forcing termination.
const forceTerminationWaitMs = 1500;
// Cleanup starts once, at stop or Windows leader exit, and allows draining after a force kill.
const cleanupWaitMs = 2500;

export class TtyBridge {
  private sent = 0;
  private consumed = 0;
  private stopping = false;
  private closed: Promise<void>;
  private beginCleanup!: () => void;

  static async start(
    socket: string,
    options: { cols: number; rows: number; term: string },
    output: (data: Buffer) => void,
    ended: () => void,
    failed: (error: unknown) => void,
  ) {
    const args = [
      String(options.cols),
      String(options.rows),
      String(limits.dataChunkBytes),
      String(limits.terminalPendingBytes),
      process.platform === "win32" ? msysPath(tmuxBinary) : tmuxBinary,
      ...tmuxAttachArgs(socket),
    ];
    const env = { ...tmuxEnvironment(), TERM: options.term };
    const child =
      process.platform === "win32"
        ? await spawnJob(ptyBridgeBinary, args, { env })
        : spawn(ptyBridgeBinary, args, { env, stdio: "pipe" });
    return new TtyBridge(child, output, ended, failed);
  }

  private constructor(
    private child: ChildProcessWithoutNullStreams | JobChild,
    output: (data: Buffer) => void,
    ended: () => void,
    failed: (error: unknown) => void,
  ) {
    let error: Error | undefined;
    let diagnostic = Buffer.alloc(0);
    child.stderr!.on("data", (data: Buffer) => {
      diagnostic = Buffer.concat([diagnostic, data.subarray(0, 8192 - diagnostic.length)]);
    });
    child.stdout!.on("data", (data: Buffer) => {
      if (this.stopping) return;
      try {
        if (this.sent - this.consumed + data.length > limits.terminalDisplayBytes)
          throw new AppError("limit_exceeded", "Terminal output was not consumed; reconnect");
        output(data);
        this.sent += data.length;
      } catch (error) {
        failed(error);
      }
    });
    child.stdin!.on("error", (error) => {
      if (!this.stopping) failed(error);
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      this.beginCleanup = () => {
        deadline ??= setTimeout(() => {
          child.stdout!.destroy();
          child.stderr!.destroy();
          reject(new Error("Terminal client cleanup timed out"));
        }, cleanupWaitMs);
      };
    });
    let closed: Promise<{ code: number | null; signal?: string | null }>;
    if (child instanceof JobChild) {
      const drained = Promise.all([
        finished(child.stdout!, { writable: false, cleanup: true }),
        finished(child.stderr!, { writable: false, cleanup: true }),
      ]);
      void drained.catch(failed);
      closed = child.exited.then(async (result) => {
        // A surviving descendant may hold the pipes open after the helper exits.
        this.beginCleanup();
        await child.stop();
        await drained;
        return result;
      });
    } else {
      child.once("error", (value) => {
        error = value;
      });
      closed = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    }
    this.closed = Promise.race([closed, timeout])
      .then(({ code, signal }) => {
        if (this.stopping) return;
        this.stopping = true;
        if (error || code !== 0)
          failed(
            new AppError(
              "command_failed",
              error?.message ||
                diagnostic.toString().trim() ||
                `Terminal client exited ${signal ?? code}`,
            ),
          );
        else ended();
      })
      .finally(() => clearTimeout(deadline));
    void this.closed.catch(failed);
  }

  acknowledge(bytes: number) {
    if (bytes < this.consumed || bytes > this.sent)
      throw new AppError("invalid_argument", "Consumed bytes must be ordered and already sent");
    this.consumed = bytes;
  }

  input(data: Buffer) {
    if (data.length) this.write("I", data);
  }

  resize(cols: number, rows: number) {
    const data = Buffer.allocUnsafe(resizePayloadBytes);
    data.writeUInt16BE(cols, resizeColsOffset);
    data.writeUInt16BE(rows, resizeRowsOffset);
    this.write("R", data);
  }

  private write(type: "I" | "R", data: Buffer) {
    if (this.stopping) throw new AppError("cancelled", "Terminal client is closing");
    const frame = Buffer.allocUnsafe(frameHeaderBytes + data.length);
    frame.write(type);
    frame.writeUInt32BE(data.length, frameLengthOffset);
    data.copy(frame, frameHeaderBytes);
    if (this.child.stdin!.writableLength + frame.length > limits.terminalPendingBytes)
      throw new AppError("limit_exceeded", "Terminal input backlog exceeds the limit");
    this.child.stdin!.write(frame);
  }

  async stop() {
    if (this.stopping) return this.closed;
    this.stopping = true;
    this.beginCleanup();
    const child = this.child;
    child.stdin!.destroy();
    if (!(child instanceof JobChild)) child.kill("SIGTERM");
    const kill = setTimeout(() => {
      if (child instanceof JobChild) child.terminate();
      else child.kill("SIGKILL");
    }, forceTerminationWaitMs);
    try {
      await this.closed;
    } finally {
      clearTimeout(kill);
    }
  }
}
