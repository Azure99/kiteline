import { serverLimits } from "./limits.js";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import {
  AppError,
  asError,
  integer,
  limits,
  record,
  type FileMeta,
  type FileReadPurpose,
  type FileWritePurpose,
} from "@kiteline/shared/protocol";
import { consumeFileFrames, sendFileFrame } from "@kiteline/shared/protocol/file-stream";
import { checkReply, parseReplyError, failure, finishRequest, json } from "./http.js";

interface FileTransferOptions {
  kind: "file.read" | "file.write";
  meta: FileMeta;
  socket: WebSocket;
  request: IncomingMessage;
  response: ServerResponse;
  fail: (error: unknown) => void;
  release: () => void;
  id: string;
  purpose: FileReadPurpose | FileWritePurpose;
}

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
  constructor(private options: FileTransferOptions) {
    const { socket, response, fail, release } = options;
    this.timer = setTimeout(
      () => fail(new AppError("timeout", "File transfer timed out with no progress")),
      serverLimits.channelIdleTimeout,
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
    const { kind, meta, socket, request, response, fail } = this.options;
    const { signal } = this.controller;
    try {
      if (kind === "file.read" && !meta.size) this.readComplete = true;
      await sendFileFrame(socket, JSON.stringify({ type: "start" }), signal);
      if (kind === "file.read") {
        if (!meta.size) {
          this.readComplete = true;
          this.headers();
          response.end();
        }
        return;
      }
      for await (const chunk of request) {
        const bytes = chunk as Buffer;
        if (this.received + bytes.length > meta.size)
          throw new AppError("invalid_argument", "Body exceeds the declared length");
        for (let offset = 0; offset < bytes.length; offset += limits.dataChunkBytes) {
          await sendFileFrame(
            socket,
            bytes.subarray(offset, offset + limits.dataChunkBytes),
            signal,
          );
          this.timer.refresh();
        }
        this.received += bytes.length;
      }
      if (this.received !== meta.size)
        throw new AppError("invalid_argument", "Body is shorter than the declared length");
      this.ended = true;
      await sendFileFrame(socket, JSON.stringify({ type: "end" }), signal);
    } catch (error) {
      if (!signal.aborted) fail(error);
    }
  }
  private headers() {
    const { purpose, meta, response } = this.options;
    finishRequest(response);
    response.writeHead(200, {
      "content-type":
        purpose === "image" || purpose === "open"
          ? meta.contentType
          : purpose === "download"
            ? "application/octet-stream"
            : "text/plain; charset=utf-8",
      "content-length": meta.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(purpose === "download"
        ? {
            "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(meta.filename).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase())}`,
          }
        : {}),
    });
  }
  private async receive(data: Buffer, binary: boolean) {
    const { kind, meta, response } = this.options;
    if (!binary) {
      const message = record(JSON.parse(data.toString()));
      if (message.type === "error") throw parseReplyError(message);
      if (kind !== "file.write" || !this.ended || message.type !== "result")
        throw new AppError("invalid_argument", "Invalid file result frame");
      const reply = checkReply(record(message.reply));
      this.resultReceived = true;
      json(response, 200, reply);
      return;
    }
    if (kind !== "file.read" || this.readComplete)
      throw new AppError("invalid_argument", "Invalid file body frame");
    const total = this.received + data.length;
    integer(total, "file bytes", 0, meta.size);
    if (!response.headersSent) this.headers();
    this.received = total;
    this.readComplete = total === meta.size;
    if (data.length) this.timer.refresh();
    if (!response.write(data)) await once(response, "drain", { signal: this.controller.signal });
    if (this.readComplete) response.end();
  }
  stop(error?: unknown) {
    const { kind, id, request, response } = this.options;
    this.controller.abort(error ?? new AppError("cancelled", "File request completed"));
    clearTimeout(this.timer);
    void this.frames.close();
    if (error && !response.writableFinished && !response.destroyed) {
      if (kind === "file.write" && !this.resultReceived)
        json(response, 200, {
          id,
          outcome: this.ended ? "unknown" : "failed",
          error: asError(error),
        });
      else failure(response, error);
    }
    if (error && !request.complete) {
      if (response.writableFinished || response.destroyed) request.destroy();
      else {
        const destroy = () => request.destroy();
        response.once("finish", destroy);
        response.once("close", destroy);
      }
    }
  }
  sourceClosed() {
    return this.frames.drain();
  }
}
