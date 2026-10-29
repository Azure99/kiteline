import { WebSocket } from "ws";
import {
  AppError,
  asError,
  errorReply,
  integer,
  limits,
  optionalString,
  record,
  string,
  type FileMeta,
  type FileReadPurpose,
} from "@kiteline/shared/protocol";
import { consumeFileFrames, sendFileFrame } from "@kiteline/shared/protocol/file-stream";
import type { AgentConfig, Identity } from "../config.js";
import type { TextFiles, TextWrite } from "./save.js";
import { readWorkspaceFile, type FileRead } from "./read.js";
import type { BinaryFiles, UploadWrite } from "./upload.js";
import { connectChannel } from "../network.js";
import type { MetadataStore } from "../metadata.js";

type FileRequest = { workspaceId: string; path: string } & (
  | { kind: "read"; purpose: FileReadPurpose }
  | {
      kind: "save";
      size: number;
      createOnly: boolean;
      expectedRevision?: string;
    }
  | {
      kind: "upload";
      size: number;
      createOnly: boolean;
      expectedTargetVersion?: string;
    }
);
type WriteTransfer = { kind: "save"; value: TextWrite } | { kind: "upload"; value: UploadWrite };
type Transfer = { kind: "read"; value: FileRead } | WriteTransfer;
type ChannelState = { phase: "preparing" } | { phase: "ready" | "streaming"; transfer: Transfer };
interface Channel {
  socket: WebSocket;
  controller: AbortController;
  preparation?: Promise<void>;
  closeFrames: () => Promise<void>;
  admitted: boolean;
  state: ChannelState;
}

export class FileChannels {
  private entries = new Map<string, Channel>();
  private cleanup = new Set<Promise<void>>();
  private cleaningCount = 0;
  constructor(
    private files: TextFiles,
    private binaryFiles: BinaryFiles,
    private metadata: MetadataStore,
    private config: AgentConfig,
    private identity: Identity,
    private readonly notifyWritten: (workspaceId: string) => void,
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
    const pump = consumeFileFrames(
      socket,
      ({ data, binary }) => this.receive(id, channel, data, binary),
      (error) => this.fail(id, error),
      controller.signal,
    );
    const channel: Channel = {
      socket,
      controller,
      admitted,
      state: { phase: "preparing" },
      closeFrames: pump.close,
    };
    this.entries.set(id, channel);
    socket.on("upgrade", (response) =>
      response.socket.setKeepAlive(true, limits.tcpKeepAliveDelayMs),
    );
    socket.on("open", () => {
      channel.preparation = this.prepare(channel, kind, params).catch((error: unknown) => {
        if (!controller.signal.aborted) this.fail(id, error);
      });
    });
    socket.on("close", () => this.cancel(id));
    socket.on("error", () => this.cancel(id));
  }

  private async prepare(channel: Channel, kind: string, params: Record<string, unknown>) {
    if (!channel.admitted) throw new AppError("busy", "Device file transfer limit reached");
    const request = parseRequest(kind, params);
    const signal = channel.controller.signal;
    let transfer: Transfer;
    let meta: FileMeta;
    if (request.kind === "read") {
      const read = await readWorkspaceFile(
        this.metadata.workspace(request.workspaceId).path,
        request.path,
        request.purpose,
        this.config.limits,
        signal,
      );
      transfer = { kind: "read", value: read };
      meta = read.meta;
    } else {
      if (request.kind === "save") {
        transfer = {
          kind: "save",
          value: await this.files.prepare(
            request.workspaceId,
            request.path,
            request.size,
            request.createOnly,
            request.expectedRevision,
            signal,
          ),
        };
      } else {
        transfer = {
          kind: "upload",
          value: await this.binaryFiles.prepare(
            request.workspaceId,
            request.path,
            request.size,
            request.createOnly,
            request.expectedTargetVersion,
            signal,
          ),
        };
      }
      meta = {
        size: request.size,
        targetPath: transfer.value.path,
        contentType:
          request.kind === "save" ? "text/plain; charset=utf-8" : "application/octet-stream",
        filename: request.path.split("/").at(-1)!,
      };
    }
    // Keep late resources owned by the channel so cancellation can finish their cleanup.
    channel.state = { phase: "ready", transfer };
    signal.throwIfAborted();
    await sendFileFrame(channel.socket, JSON.stringify({ type: "ready", meta }), signal);
  }

  private async receive(id: string, channel: Channel, data: Buffer, binary: boolean) {
    const frame = binary ? undefined : record(JSON.parse(data.toString()));
    const state = channel.state;
    if (state.phase === "preparing")
      throw new AppError("invalid_argument", "File channel is not ready");
    const { transfer } = state;
    if (state.phase === "ready") {
      if (frame?.type !== "start")
        throw new AppError("invalid_argument", "File channel is not ready");
      channel.state = { phase: "streaming", transfer };
      if (transfer.kind === "read") await this.streamRead(id, channel, transfer.value);
      return;
    }
    if (transfer.kind === "read")
      throw new AppError("invalid_argument", "File reads do not accept a body");
    if (binary) {
      const item = transfer.value;
      const signal = channel.controller.signal;
      signal.throwIfAborted();
      if (item.temporary.bytesWritten + data.length > item.size)
        throw new AppError("invalid_argument", "Received body exceeds the declared length");
      await item.temporary.write(data, signal);
    } else if (frame?.type === "end") {
      await this.completeWrite(id, channel, transfer);
    } else throw new AppError("invalid_argument", "Invalid file control frame");
  }

  private async streamRead(id: string, channel: Channel, read: FileRead) {
    const signal = channel.controller.signal;
    const send = (data: Buffer) => sendFileFrame(channel.socket, data, signal);
    const { size } = read.meta;
    const last = Math.max(0, size - limits.dataChunkBytes);
    let offset = 0;
    while (offset < last) {
      const end = Math.min(last, offset + limits.dataChunkBytes);
      await send(await read.read(offset, end - offset));
      offset = end;
    }
    // Receiving exactly size bytes means success, so verify before sending the last block.
    const tail = await read.read(last, size - last);
    await read.finish();
    if (size) await send(tail);
    this.finish(id, { graceful: true });
  }

  private async completeWrite(id: string, channel: Channel, write: WriteTransfer) {
    const signal = channel.controller.signal;
    let reply;
    try {
      reply = {
        id,
        outcome: "succeeded",
        result:
          write.kind === "save"
            ? await this.files.save(write.value, signal)
            : await this.binaryFiles.save(write.value, signal),
      };
    } catch (error) {
      reply = errorReply(id, error);
    }
    if (write.value.temporary.mayHaveChangedTarget) this.notifyWritten(write.value.workspaceId);
    await sendFileFrame(channel.socket, JSON.stringify({ type: "result", reply }), signal);
    this.finish(id, { graceful: true });
  }

  private fail(id: string, error: unknown) {
    const channel = this.entries.get(id);
    if (!channel) return;
    if (channel.socket.readyState === WebSocket.OPEN)
      channel.socket.send(JSON.stringify({ type: "error", ...asError(error) }));
    this.finish(id, { error, graceful: true });
  }
  cancel(id: string) {
    this.finish(id, {
      error: new AppError("cancelled", "File request cancelled"),
      graceful: false,
    });
  }
  private finish(id: string, { error, graceful }: { error?: unknown; graceful: boolean }) {
    const channel = this.entries.get(id);
    if (!channel) return;
    this.entries.delete(id);
    if (channel.admitted) this.cleaningCount++;
    channel.controller.abort(error ?? new AppError("cancelled", "File request completed"));
    if (graceful && channel.socket.readyState === WebSocket.OPEN) {
      channel.socket.resume();
      channel.socket.close(1000);
    } else channel.socket.terminate();
    const cleanup = this.cleanupChannel(channel);
    this.cleanup.add(cleanup);
    void cleanup.finally(() => {
      this.cleanup.delete(cleanup);
      if (channel.admitted) this.cleaningCount--;
    });
  }
  private async cleanupChannel(channel: Channel) {
    const finish = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        console.error("File cleanup:", error);
      }
    };
    await finish(() => channel.preparation);
    await finish(() => channel.closeFrames());
    const { state } = channel;
    if (state.phase === "preparing") return;
    const { transfer } = state;
    await finish(() =>
      transfer.kind === "read" ? transfer.value.close() : transfer.value.temporary.dispose(),
    );
  }
  async close() {
    for (const id of this.entries.keys()) this.cancel(id);
    await Promise.all([...this.cleanup]);
  }
}

function parseRequest(kind: string, params: Record<string, unknown>): FileRequest {
  const workspaceId = string(params.workspaceId);
  const path = string(params.path);
  const purpose = params.purpose;
  if (
    kind === "file.read" &&
    (purpose === "text" || purpose === "open" || purpose === "image" || purpose === "download")
  )
    return { kind: "read", workspaceId, path, purpose };
  if (kind !== "file.write" || (purpose !== "save" && purpose !== "upload"))
    throw new AppError("unsupported", "Unsupported file channel purpose");
  const createOnly = params.createOnly;
  if (typeof createOnly !== "boolean")
    throw new AppError("invalid_argument", "Invalid save parameters");
  const size = integer(params.size, "size", 0, Number.MAX_SAFE_INTEGER);
  if (purpose === "save") {
    if (params.expectedTargetVersion !== undefined)
      throw new AppError("invalid_argument", "Saving does not use a directory entry version");
    return {
      kind: "save",
      workspaceId,
      path,
      size,
      createOnly,
      expectedRevision: optionalString(params.expectedRevision),
    };
  }
  if (params.expectedRevision !== undefined)
    throw new AppError("invalid_argument", "Uploading does not use a text revision");
  return {
    kind: "upload",
    workspaceId,
    path,
    size,
    createOnly,
    expectedTargetVersion: optionalString(params.expectedTargetVersion),
  };
}
