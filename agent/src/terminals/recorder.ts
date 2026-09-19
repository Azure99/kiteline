import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AppError, OperationError } from "@kiteline/shared/protocol";
import type {
  RecorderCall,
  RecorderConfig,
  RecorderMessage,
  RecorderRequest,
} from "@kiteline/shared/ipc";
import { JsonWriter, readLines } from "@kiteline/shared/stdio";

export class Recorder {
  private child?: ChildProcessWithoutNullStreams;
  private writer?: JsonWriter;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  onMessage?: (message: RecorderMessage) => void;
  onExit?: (reason: string) => void;
  constructor(private config: RecorderConfig) {}
  get available() {
    return !!this.child;
  }
  get pid() {
    return this.child?.pid;
  }
  private ensure() {
    if (this.available) return;
    const child = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../terminal-recorder/dist/main.js"),
        "--agent",
        JSON.stringify(this.config),
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    const writer = new JsonWriter(child.stdin);
    this.writer = writer;
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      if (stderr.length < 8192) stderr += data.toString();
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      stderr = error.message;
    });
    readLines(
      child.stdout,
      (line) => {
        if (this.child !== child) return;
        const message = JSON.parse(line.toString()) as RecorderMessage;
        if (message.type === "reply") {
          const pending = this.pending.get(message.reply.id);
          if (pending) {
            this.pending.delete(message.reply.id);
            clearTimeout(pending.timer);
            if (message.reply.outcome === "succeeded") pending.resolve(message.reply.result);
            else if (message.reply.outcome === "failed")
              pending.reject(new AppError(message.reply.error.code, message.reply.error.message));
            else
              pending.reject(
                new OperationError(
                  message.reply.error.code,
                  message.reply.error.message,
                  message.reply.outcome,
                  message.reply.result,
                ),
              );
          }
        } else this.onMessage?.(message);
      },
      (error) => {
        stderr = error.message;
        child.kill("SIGTERM");
      },
    );
    child.on("close", () => {
      writer.close();
      if (this.child !== child) return;
      this.child = undefined;
      this.writer = undefined;
      const reason = stderr.trim() || "Terminal recorder exited";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new OperationError("recording_unavailable", reason, "unknown"));
      }
      this.pending.clear();
      this.onExit?.(reason);
    });
  }
  request<T>(message: RecorderCall): Promise<T> {
    this.ensure();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OperationError("timeout", "Recorder did not acknowledge the operation", "unknown"),
        );
      }, this.config.channelPairTimeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.send({ ...message, id } as RecorderRequest);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  send(message: RecorderRequest) {
    if (!this.available || !this.writer)
      throw new AppError("recording_unavailable", "Terminal recorder is unavailable");
    const owner = "attachmentId" in message ? message.attachmentId : undefined;
    if (!this.writer.send(message, owner))
      throw new AppError("limit_exceeded", "Terminal IPC send backlog limit reached");
  }
  detach(sessionId: string, attachmentId: string) {
    this.writer?.discard(attachmentId);
    if (this.available) this.send({ type: "detach", sessionId, attachmentId });
  }
  async close() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => child.kill("SIGKILL"), this.config.channelPairTimeout);
      child.once("close", () => {
        clearTimeout(deadline);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
