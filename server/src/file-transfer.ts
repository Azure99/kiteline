import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import {
  AppError,
  asError,
  integer,
  limits,
  record,
  string,
  type FileMeta,
  type Reply,
} from "@kiteline/shared/protocol";
import { consumeFileFrames, sendFileFrame } from "@kiteline/shared/file-stream";
import { failure, json } from "./http.js";

export class FileTransfer {
  readonly controller = new AbortController();
  readComplete = false;
  private resultReceived = false;
  get sourceComplete() {
    return this.readComplete || this.resultReceived;
  }
  private received = 0;
  private ended = false;
  private timer: NodeJS.Timeout;
  private frames: ReturnType<typeof consumeFileFrames>;
  constructor(
    private kind: "file.read" | "file.write",
    private meta: FileMeta,
    private socket: WebSocket,
    private request: IncomingMessage,
    private response: ServerResponse,
    idleTimeout: number,
    private fail: (error: unknown) => void,
    private release: () => void,
    private id: string,
    private purpose = "text",
  ) {
    this.timer = setTimeout(
      () => fail(new AppError("timeout", "File transfer timed out with no progress")),
      idleTimeout,
    );
    this.frames = consumeFileFrames(
      socket,
      (frame) => this.receive(frame.data, frame.binary),
      fail,
      this.controller.signal,
    );
    response.once("error", fail);
    response.once("finish", release);
    response.once("close", () => {
      if (response.writableFinished) release();
      else fail(new AppError("cancelled", "File request closed"));
    });
  }
  async start() {
    const { signal } = this.controller;
    try {
      if (this.kind === "file.read" && !this.meta.size) this.readComplete = true;
      await sendFileFrame(this.socket, JSON.stringify({ type: "start" }), signal);
      if (this.kind === "file.read") {
        if (!this.meta.size) {
          this.readComplete = true;
          this.headers();
          this.response.end();
        }
        return;
      }
      for await (const chunk of this.request) {
        const bytes = chunk as Buffer;
        if (this.received + bytes.length > this.meta.size)
          throw new AppError("invalid_argument", "Body exceeds the declared length");
        for (let offset = 0; offset < bytes.length; offset += limits.dataChunkBytes) {
          await sendFileFrame(
            this.socket,
            bytes.subarray(offset, offset + limits.dataChunkBytes),
            signal,
          );
          this.timer.refresh();
        }
        this.received += bytes.length;
      }
      if (this.received !== this.meta.size)
        throw new AppError("invalid_argument", "Body is shorter than the declared length");
      this.ended = true;
      await sendFileFrame(this.socket, JSON.stringify({ type: "end" }), signal);
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    }
  }
  private headers() {
    this.response.writeHead(200, {
      "content-type":
        this.purpose === "image" || this.purpose === "open"
          ? this.meta.contentType
          : this.purpose === "download"
            ? "application/octet-stream"
            : "text/plain; charset=utf-8",
      "content-length": this.meta.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(this.purpose === "download"
        ? {
            "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(this.meta.filename).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase())}`,
          }
        : {}),
    });
  }
  private async receive(data: Buffer, binary: boolean) {
    if (!binary) {
      const message = record(JSON.parse(data.toString()));
      if (message.type === "error")
        throw new AppError(string(message.code), string(message.message), message.details);
      if (this.kind !== "file.write" || !this.ended || message.type !== "result")
        throw new AppError("invalid_argument", "Invalid file result frame");
      const reply = record(message.reply) as unknown as Reply;
      if (!["succeeded", "failed", "partial", "unknown"].includes(reply.outcome))
        throw new AppError("invalid_argument", "Invalid file result");
      this.resultReceived = true;
      json(this.response, 200, reply);
      return;
    }
    if (this.kind !== "file.read" || this.readComplete)
      throw new AppError("invalid_argument", "Invalid file body frame");
    const total = this.received + data.length;
    integer(total, "file bytes", 0, this.meta.size);
    if (!this.response.headersSent) this.headers();
    this.received = total;
    this.readComplete = total === this.meta.size;
    if (data.length) this.timer.refresh();
    if (!this.response.write(data))
      await once(this.response, "drain", { signal: this.controller.signal });
    if (this.readComplete) this.response.end();
  }
  stop(error?: unknown) {
    this.controller.abort(error ?? new AppError("cancelled", "File request completed"));
    clearTimeout(this.timer);
    void this.frames.close();
    if (error && !this.response.writableFinished && !this.response.destroyed) {
      if (this.kind === "file.write" && !this.resultReceived)
        json(this.response, 200, {
          id: this.id,
          outcome: this.ended ? "unknown" : "failed",
          error: asError(error),
        });
      else failure(this.response, error);
    }
    if (error && !this.request.complete) {
      if (this.response.writableFinished || this.response.destroyed) this.request.destroy();
      else {
        const destroy = () => this.request.destroy();
        this.response.once("finish", destroy);
        this.response.once("close", destroy);
      }
    }
  }
  sourceClosed() {
    return this.frames.drain();
  }
}
