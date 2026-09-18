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
import { consumeFileFrames, sendFileFrame } from "@kiteline/shared/file-stream";
import type { AgentConfig, Identity } from "../config.js";
import type { TextFiles, FileRead, TextWrite } from "./text.js";
import type { BinaryFiles, UploadWrite } from "./binary.js";

interface Channel {
  socket: WebSocket;
  controller: AbortController;
  timer: NodeJS.Timeout;
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
    private config: AgentConfig,
    private identity: Identity,
    private otherChannels: () => number,
  ) {}
  get count() {
    return this.cleaningCount + [...this.entries.values()].filter((item) => item.admitted).length;
  }
  open(id: string, connectionId: string, kind: string, params: Record<string, unknown>) {
    const admitted =
      this.count < this.config.limits.transfersPerDevice &&
      this.count + this.otherChannels() < this.config.limits.channelsPerDevice;
    const url = new URL(`/api/agent/channels/${encodeURIComponent(id)}`, this.identity.server);
    url.protocol = "wss:";
    url.searchParams.set("connectionId", connectionId);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.identity.deviceToken}` },
      maxPayload: limits.controlMessageBytes,
      handshakeTimeout: this.config.limits.channelPairTimeout,
    });
    const controller = new AbortController();
    const signal = controller.signal;
    const channel: Channel = {
      socket,
      controller,
      admitted,
      ready: false,
      started: false,
      timer: setTimeout(
        () => this.fail(id, new AppError("timeout", "文件准备超时")),
        this.config.limits.channelPairTimeout,
      ),
      prepare: Promise.resolve(),
      dispose: async () => {},
    };
    this.entries.set(id, channel);
    const touch = () => channel.timer.refresh();
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
            throw new AppError("invalid_argument", "文件通道尚未就绪");
          channel.started = true;
          clearTimeout(channel.timer);
          channel.timer = setTimeout(
            () => this.fail(id, new AppError("timeout", "文件传输长时间未推进")),
            this.config.limits.channelIdleTimeout,
          );
          if (channel.read) {
            const { size } = channel.read.meta;
            const last = Math.max(0, size - limits.dataChunkBytes);
            let offset = 0;
            while (offset < last) {
              const end = Math.min(last, offset + limits.dataChunkBytes);
              await send(await channel.read.read(offset, end - offset));
              offset = end;
              touch();
            }
            const tail = await channel.read.read(last, size - last);
            await channel.read.finish();
            if (size) {
              await send(tail);
              touch();
            }
            this.finish(id, undefined, true);
          }
        } else if (channel.write) {
          if (binary) {
            await this.files.write(channel.write.value, data, signal);
            if (data.length) touch();
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
            await send(JSON.stringify({ type: "result", reply }));
            this.finish(id, undefined, true);
          } else throw new AppError("invalid_argument", "无效文件控制帧");
        } else throw new AppError("invalid_argument", "文件读取不接受正文");
      },
      (error) => this.fail(id, error),
      signal,
    ).close;
    socket.on("open", () => {
      channel.prepare = (async () => {
        if (!admitted) throw new AppError("busy", "设备文件传输名额已满");
        const workspaceId = string(params.workspaceId);
        const path = string(params.path);
        let meta;
        if (kind === "file.read" && params.purpose === "text") {
          channel.read = await this.files.read(workspaceId, path, signal);
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
            throw new AppError("invalid_argument", "无效保存参数");
          const size = integer(
            params.size,
            "size",
            0,
            params.purpose === "save"
              ? this.config.limits.editorBytes
              : this.config.limits.transferBytes,
          );
          if (params.purpose === "save") {
            if (params.expectedTargetVersion !== undefined)
              throw new AppError("invalid_argument", "保存不使用目录项版本");
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
              throw new AppError("invalid_argument", "上传不使用文本版本");
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
        } else throw new AppError("unsupported", "不支持的文件通道用途");
        signal.throwIfAborted();
        clearTimeout(channel.timer);
        channel.timer = setTimeout(
          () => this.fail(id, new AppError("timeout", "等待文件请求超时")),
          this.config.limits.channelPairTimeout,
        );
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
    this.finish(id, new AppError("cancelled", "文件请求已取消"), false);
  }
  private finish(id: string, error: unknown, graceful: boolean) {
    const channel = this.entries.get(id);
    if (!channel) return;
    this.entries.delete(id);
    if (channel.admitted) this.cleaningCount++;
    clearTimeout(channel.timer);
    channel.controller.abort(error ?? new AppError("cancelled", "文件请求已完成"));
    if (graceful && channel.socket.readyState === WebSocket.OPEN) {
      channel.socket.resume();
      channel.socket.close(1000);
    } else channel.socket.terminate();
    const cleanup = (async () => {
      await channel.prepare;
      await channel.dispose();
      await channel.read?.close();
      if (channel.write) await this.files.cleanup(channel.write.value);
    })().catch((error: unknown) => console.error("File cleanup:", error));
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
