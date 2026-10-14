import { spawn } from "node:child_process";
import { AppError, limits } from "@kiteline/shared/protocol";
import {
  ptyBridgeBinary,
  tmuxAttachArgs,
  tmuxBinary,
  tmuxEnvironment,
} from "@kiteline/shared/terminal/node";

export class TtyBridge {
  private child;
  private sent = 0;
  private consumed = 0;
  private stopping = false;
  private closed: Promise<void>;

  constructor(
    socket: string,
    options: { cols: number; rows: number; term: string },
    output: (data: Buffer) => void,
    ended: () => void,
    failed: (error: unknown) => void,
  ) {
    const child = (this.child = spawn(
      ptyBridgeBinary,
      [
        String(options.cols),
        String(options.rows),
        String(limits.dataChunkBytes),
        String(limits.terminalPendingBytes),
        tmuxBinary,
        ...tmuxAttachArgs(socket),
      ],
      { env: { ...tmuxEnvironment(), TERM: options.term }, stdio: "pipe" },
    ));
    let error: Error | undefined;
    let diagnostic = Buffer.alloc(0);
    child.once("error", (value) => {
      error = value;
    });
    child.stderr.on("data", (data: Buffer) => {
      diagnostic = Buffer.concat([diagnostic, data.subarray(0, 8192 - diagnostic.length)]);
    });
    child.stdout.on("data", (data: Buffer) => {
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
    child.stdin.on("error", (error) => {
      if (!this.stopping) failed(error);
    });
    this.closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve();
        if (this.stopping) return;
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
      });
    });
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
    const data = Buffer.allocUnsafe(4);
    data.writeUInt16BE(cols, 0);
    data.writeUInt16BE(rows, 2);
    this.write("R", data);
  }

  private write(type: string, data: Buffer) {
    if (this.stopping) throw new AppError("cancelled", "Terminal client is closing");
    const frame = Buffer.allocUnsafe(5 + data.length);
    frame.write(type);
    frame.writeUInt32BE(data.length, 1);
    data.copy(frame, 5);
    if (this.child.stdin.writableLength + frame.length > limits.terminalPendingBytes)
      throw new AppError("limit_exceeded", "Terminal input backlog exceeds the limit");
    this.child.stdin.write(frame);
  }

  async stop() {
    this.stopping = true;
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    let deadline: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Terminal client cleanup timed out")), 2500);
        }),
      ]);
    } finally {
      clearTimeout(kill);
      clearTimeout(deadline!);
    }
  }
}
