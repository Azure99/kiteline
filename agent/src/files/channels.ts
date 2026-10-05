import { WebSocket } from "ws";
import {
  AppError,
  asError,
  errorReply,
  integer,
  limits,
  record,
  string,
} from "@kiteline/shared/protocol";
import { consumeFileFrames, sendFileFrame } from "@kiteline/shared/protocol/file-stream";
import type { AgentConfig, Identity } from "../config.js";
import type { TextFiles, TextWrite } from "./text.js";
import type { FileRead } from "./read.js";
import type { BinaryFiles, UploadWrite } from "./binary.js";
import type { TemporaryFiles } from "./temporary.js";
import { connectChannel } from "../network.js";

interface Channel {
  socket: WebSocket;
  controller: AbortController;
  prepare: Promise<void>;
  dispose: () => Promise<void>;
  admitted: boolean;
  ready: boolean;
  started: boolean;
  read?: FileRead;
  write?: { purpose: "save"; value: TextWrite } | { purpose: "upload"; value: UploadWrite };
}
export class FileChannels {
  private entries = new Map<string, Channel>();
  private cleanup = new Set<Promise<void>>();
  private cleaningCount = 0;
  constructor(
    private files: TextFiles,
    private binaryFiles: BinaryFiles,
    private temporary: TemporaryFiles,
    private config: AgentConfig,
    private identity: Identity,
    private changed: (workspaceId: string) => void = () => {},
  ) {}
  get count() {
    return this.cleaningCount + [...this.entries.values()].filter((item) => item.admitted).length;
  }
  open(id: string, connectionId: string, kind: string, params: Record<string, unknown>) {
    const admitted = this.count < this.config.limits.transfersPerDevice;
    const socket = connectChannel(this.identity, id, connectionId, {
      maxPayload: limits.controlMessageBytes,
    });
    const controller = new AbortController();
    const signal = controller.signal;
    const channel: Channel = {
      socket,
      controller,
      admitted,
      ready: false,
      started: false,
      prepare: Promise.resolve(),
      dispose: async () => {},
    };
    this.entries.set(id, channel);
    const send = (data: Buffer | string) => sendFileFrame(socket, data, signal);
    socket.on("upgrade", (response) =>
      response.socket.setKeepAlive(true, limits.tcpKeepAliveDelayMs),
    );
    channel.dispose = consumeFileFrames(
      socket,
      async ({ data, binary }) => {
        const frame = binary ? undefined : record(JSON.parse(data.toString()));
        if (!channel.started) {
          if (!channel.ready || frame?.type !== "start")
            throw new AppError("invalid_argument", "File channel is not ready");
          channel.started = true;
          if (channel.read) {
            const { size } = channel.read.meta;
            const last = Math.max(0, size - limits.dataChunkBytes);
            let offset = 0;
            while (offset < last) {
              const end = Math.min(last, offset + limits.dataChunkBytes);
              await send(await channel.read.read(offset, end - offset));
              offset = end;
            }
            const tail = await channel.read.read(last, size - last);
            await channel.read.finish();
            if (size) {
              await send(tail);
            }
            this.finish(id, undefined, true);
          }
        } else if (channel.write) {
          if (binary) {
            const item = channel.write.value;
            signal.throwIfAborted();
            if (item.received + data.length > item.size)
              throw new AppError("invalid_argument", "Received body exceeds the declared length");
            item.received += await this.temporary.write(
              item.temporary,
              data,
              item.received,
              signal,
            );
          } else if (frame?.type === "end") {
            let reply;
            try {
              reply = {
                id,
                outcome: "succeeded",
                result:
                  channel.write.purpose === "save"
                    ? await this.files.save(channel.write.value, signal)
                    : await this.binaryFiles.save(channel.write.value, signal),
              };
            } catch (error) {
              reply = errorReply(id, error);
            }
            if (channel.write.value.published || channel.write.value.uncertain)
              this.changed(channel.write.value.workspaceId);
            await send(JSON.stringify({ type: "result", reply }));
            this.finish(id, undefined, true);
          } else throw new AppError("invalid_argument", "Invalid file control frame");
        } else throw new AppError("invalid_argument", "File reads do not accept a body");
      },
      (error) => this.fail(id, error),
      signal,
    ).close;
    socket.on("open", () => {
      channel.prepare = (async () => {
        if (!admitted) throw new AppError("busy", "Device file transfer limit reached");
        const workspaceId = string(params.workspaceId);
        const path = string(params.path);
        let meta;
        if (kind === "file.read" && (params.purpose === "text" || params.purpose === "open")) {
          channel.read = await this.files.read(workspaceId, path, signal, params.purpose);
          meta = channel.read.meta;
        } else if (
          kind === "file.read" &&
          (params.purpose === "image" || params.purpose === "download")
        ) {
          channel.read = await this.binaryFiles.read(workspaceId, path, params.purpose, signal);
          meta = channel.read.meta;
        } else if (
          kind === "file.write" &&
          (params.purpose === "save" || params.purpose === "upload")
        ) {
          if (typeof params.createOnly !== "boolean")
            throw new AppError("invalid_argument", "Invalid save parameters");
          const size = integer(params.size, "size", 0, Number.MAX_SAFE_INTEGER);
          if (params.purpose === "save") {
            if (params.expectedTargetVersion !== undefined)
              throw new AppError(
                "invalid_argument",
                "Saving does not use a directory entry version",
              );
            channel.write = {
              purpose: "save",
              value: await this.files.prepare(
                workspaceId,
                path,
                size,
                params.createOnly,
                params.expectedRevision === undefined ? undefined : string(params.expectedRevision),
                signal,
              ),
            };
          } else {
            if (params.expectedRevision !== undefined)
              throw new AppError("invalid_argument", "Uploading does not use a text revision");
            channel.write = {
              purpose: "upload",
              value: await this.binaryFiles.prepare(
                workspaceId,
                path,
                size,
                params.createOnly,
                params.expectedTargetVersion === undefined
                  ? undefined
                  : string(params.expectedTargetVersion),
                signal,
              ),
            };
          }
          meta = {
            size,
            targetPath: channel.write.value.path,
            contentType:
              params.purpose === "save" ? "text/plain; charset=utf-8" : "application/octet-stream",
            filename: path.split("/").at(-1)!,
          };
        } else throw new AppError("unsupported", "Unsupported file channel purpose");
        signal.throwIfAborted();
        channel.ready = true;
        await send(JSON.stringify({ type: "ready", meta }));
      })().catch((error: unknown) => {
        if (!signal.aborted) this.fail(id, error);
      });
    });
    socket.on("close", () => this.cancel(id));
    socket.on("error", () => this.cancel(id));
  }
  private fail(id: string, error: unknown) {
    const channel = this.entries.get(id);
    if (!channel) return;
    if (channel.socket.readyState === WebSocket.OPEN)
      channel.socket.send(JSON.stringify({ type: "error", ...asError(error) }));
    this.finish(id, error, true);
  }
  cancel(id: string) {
    this.finish(id, new AppError("cancelled", "File request cancelled"), false);
  }
  private finish(id: string, error: unknown, graceful: boolean) {
    const channel = this.entries.get(id);
    if (!channel) return;
    this.entries.delete(id);
    if (channel.admitted) this.cleaningCount++;
    channel.controller.abort(error ?? new AppError("cancelled", "File request completed"));
    if (graceful && channel.socket.readyState === WebSocket.OPEN) {
      channel.socket.resume();
      channel.socket.close(1000);
    } else channel.socket.terminate();
    const cleanup = (async () => {
      const finish = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          console.error("File cleanup:", error);
        }
      };
      await finish(() => channel.prepare);
      await finish(() => channel.dispose());
      await finish(() => channel.read?.close());
      if (channel.write) {
        const item = channel.write.value;
        await finish(() => this.temporary.release(item.temporary, item));
      }
    })();
    this.cleanup.add(cleanup);
    void cleanup.finally(() => {
      this.cleanup.delete(cleanup);
      if (channel.admitted) this.cleaningCount--;
    });
  }
  async close() {
    for (const id of this.entries.keys()) this.cancel(id);
    await Promise.all([...this.cleanup]);
  }
}
