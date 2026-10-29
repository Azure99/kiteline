import { serverLimits } from "./limits.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  AppError,
  asError,
  integer,
  limits,
  record,
  string,
  type TerminalMeta,
  type FileMeta,
  type ChannelReady,
  type FileReadPurpose,
  type FileWritePurpose,
  type ServerControlMessage,
} from "@kiteline/shared/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { heartbeat, sendFrame } from "@kiteline/shared/protocol/ws";
import { httpStream } from "@kiteline/shared/protocol/http-stream";
import type { Login } from "./store.js";
import type { AgentConnection, Connections } from "./connections.js";
import { FileTransfer } from "./file-transfer.js";
import { parseReplyError } from "./agent-messages.js";

type TerminalRequest = {
  kind: "terminal.attach";
  params: Record<string, unknown> & { workspaceId: string };
};
type FileReadRequest = {
  kind: "file.read";
  params: Record<string, unknown> & {
    workspaceId: string;
    path: string;
    purpose: FileReadPurpose;
  };
};
type FileWriteRequest = {
  kind: "file.write";
  params: Record<string, unknown> & {
    workspaceId: string;
    path: string;
    purpose: FileWritePurpose;
    size: number;
  };
};
type ChannelRequest =
  | TerminalRequest
  | FileReadRequest
  | FileWriteRequest
  | { kind: "http.proxy"; params: { port: number } };

function parsePublicRequest(
  kind: string,
  params: Record<string, unknown>,
): TerminalRequest | FileReadRequest | FileWriteRequest {
  if (kind !== "terminal.attach" && kind !== "file.read" && kind !== "file.write")
    throw new AppError("unsupported", "Unsupported data channel");
  const workspaceId = string(params.workspaceId);
  if (kind === "terminal.attach") return { kind, params: { ...params, workspaceId } };
  const path = string(params.path);
  const purpose = params.purpose;
  if (kind === "file.read") {
    if (purpose !== "open" && purpose !== "text" && purpose !== "image")
      throw new AppError("unsupported", "Unsupported file purpose");
    return { kind, params: { ...params, workspaceId, path, purpose } };
  }
  if (purpose !== "save" && purpose !== "upload")
    throw new AppError("unsupported", "Unsupported file purpose");
  const size = integer(params.size, "size", 0, Number.MAX_SAFE_INTEGER);
  return { kind, params: { ...params, workspaceId, path, purpose, size } };
}

function parseReady(text: string): Record<string, unknown> {
  const message = record(JSON.parse(text));
  if (message.type === "error") throw parseReplyError(message);
  if (message.type !== "ready")
    throw new AppError("invalid_argument", "Expected a channel ready message");
  return record(message.meta);
}

export interface ChannelPolicy {
  channelsPerDevice: number;
  pairingTimeoutMs: number;
}

interface ChannelEntry {
  id: string;
  loginId: string;
  connection: AgentConnection;
  timer: NodeJS.Timeout;
  agent?: WebSocket;
  resolve: () => void;
  reject: (error: unknown) => void;
}
interface TerminalChannel extends ChannelEntry {
  kind: "terminal.attach";
  browser?: WebSocket;
  meta?: TerminalMeta;
  terminalFinished?: boolean;
}
type FileChannel = ChannelEntry &
  (FileReadRequest | FileWriteRequest) & {
    meta?: FileMeta;
    transfer?: FileTransfer;
    download?: { request: IncomingMessage; response: ServerResponse };
  };
interface HttpChannel extends ChannelEntry {
  kind: "http.proxy";
  stream?: Duplex;
  failed: (error: unknown) => void;
}
type Channel = TerminalChannel | FileChannel | HttpChannel;

export class Channels {
  private entries = new Map<string, Channel>();
  private readonly policy: ChannelPolicy;
  constructor(
    private connections: Connections,
    policy: Partial<ChannelPolicy> = {},
  ) {
    this.policy = {
      channelsPerDevice: serverLimits.channelsPerDevice,
      pairingTimeoutMs: limits.interactionTimeout,
      ...policy,
    };
  }
  cancelLogin(loginId: string, error: AppError) {
    for (const item of this.entries.values())
      if (item.loginId === loginId) this.cancel(item.id, error);
  }
  cancelConnection(connection: AgentConnection, error: AppError) {
    for (const item of this.entries.values())
      if (item.connection === connection) this.cancel(item.id, error);
  }
  create(deviceId: string, login: Login, kind: string, params: Record<string, unknown>) {
    const request = parsePublicRequest(kind, params);
    const { entry, message, ready } = this.prepare(deviceId, login, request);
    const item: TerminalChannel | FileChannel =
      request.kind === "terminal.attach"
        ? { ...entry, kind: request.kind }
        : { ...entry, ...request };
    this.register(item, message);
    return {
      id: item.id,
      ready: ready.then(
        (): ChannelReady => ({
          channelId: item.id,
          meta: item.meta!,
        }),
      ),
    };
  }
  createDownload(
    deviceId: string,
    login: Login,
    target: { workspaceId: string; path: string },
    download: { request: IncomingMessage; response: ServerResponse },
  ) {
    const request: FileReadRequest = {
      kind: "file.read",
      params: { ...target, purpose: "download" },
    };
    const { entry, message, ready } = this.prepare(deviceId, login, request);
    const item: FileChannel = { ...entry, ...request, download };
    this.register(item, message);
    download.response.on("close", () => {
      if (!download.response.writableFinished)
        this.cancel(item.id, new AppError("cancelled", "Download cancelled"));
    });
    return ready;
  }
  private prepare(deviceId: string, login: Login, request: ChannelRequest) {
    const id = randomUUID();
    const connection = this.connections.online(deviceId);
    const unavailable = (error: AppError): never => {
      if (request.kind === "file.read")
        this.notifyFileFailure(id, login.id, deviceId, request.params, error);
      throw error;
    };
    if (!connection) return unavailable(this.connections.unavailableError(deviceId));
    const message = {
      type: "channel.open",
      channelId: id,
      connectionId: connection.connectionId,
      ...request,
    } satisfies ServerControlMessage;
    if (Buffer.byteLength(JSON.stringify(message)) > limits.controlMessageBytes)
      return unavailable(new AppError("limit_exceeded", "Channel request exceeds the size limit"));
    if (
      [...this.entries.values()].filter((item) => item.connection === connection).length >=
      this.policy.channelsPerDevice
    )
      return unavailable(new AppError("busy", "Device channel limit reached"));
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((onReady, onError) => {
      resolve = onReady;
      reject = onError;
    });
    const entry: ChannelEntry = {
      id,
      connection,
      loginId: login.id,
      timer: setTimeout(
        () => this.cancel(id, new AppError("timeout", "Channel pairing timed out")),
        this.policy.pairingTimeoutMs,
      ),
      resolve,
      reject,
    };
    return { entry, message, ready };
  }
  private register(item: Channel, message: ServerControlMessage) {
    this.entries.set(item.id, item);
    this.connections.send(item.connection.socket, message);
  }
  checkAgent(id: string, deviceId: string, connectionId: string) {
    const item = this.entries.get(id);
    if (
      !item ||
      item.agent ||
      item.connection.id !== deviceId ||
      item.connection.connectionId !== connectionId ||
      this.connections.online(deviceId) !== item.connection
    )
      throw new AppError("forbidden", "Data channel is no longer valid");
    return { kind: item.kind, accept: (socket: WebSocket) => this.acceptAgent(item, socket) };
  }
  private acceptAgent(item: Channel, socket: WebSocket) {
    item.agent = socket;
    switch (item.kind) {
      case "terminal.attach":
        this.acceptTerminalAgent(item, socket);
        break;
      case "file.read":
      case "file.write":
        this.acceptFileAgent(item, socket);
        break;
      case "http.proxy":
        this.acceptHttpAgent(item, socket);
        break;
    }
  }

  private acceptTerminalAgent(item: TerminalChannel, socket: WebSocket) {
    const { id } = item;
    heartbeat(socket);
    socket.on("message", (raw, binary) => {
      try {
        if (this.entries.get(id) !== item) return;
        if (item.browser) {
          if (!binary) {
            const frame = record(JSON.parse(raw.toString()));
            if (frame.type === "ended" || frame.type === "error") item.terminalFinished = true;
          }
          sendFrame(item.browser, binary ? Buffer.from(raw as Buffer) : raw.toString(), binary);
          return;
        }
        if (binary || item.meta)
          throw new AppError("invalid_argument", "Channel has not been paired");
        item.meta = parseReady(raw.toString()) as unknown as TerminalMeta;
        clearTimeout(item.timer);
        item.timer = setTimeout(
          () => this.cancel(id, new AppError("timeout", "Timed out waiting for browser pairing")),
          this.policy.pairingTimeoutMs,
        );
        item.resolve();
      } catch (error) {
        this.cancel(id, error);
      }
    });
    socket.on("close", () =>
      this.cancel(id, new AppError("offline", "Device data connection closed")),
    );
  }
  checkBrowser(id: string, loginId: string) {
    const item = this.entries.get(id);
    if (!item || item.loginId !== loginId)
      throw new AppError("not_found", "Data channel not found");
    if (
      item.kind !== "terminal.attach" ||
      item.browser ||
      !item.meta ||
      item.agent?.readyState !== WebSocket.OPEN
    )
      throw new AppError("conflict", "Data channel cannot be joined");
    const agent = item.agent;
    return { accept: (socket: WebSocket) => this.acceptBrowser(item, agent, socket) };
  }
  private acceptBrowser(item: TerminalChannel, agent: WebSocket, socket: WebSocket) {
    const { id } = item;
    item.browser = socket;
    clearTimeout(item.timer);
    heartbeat(socket);
    socket.on("message", (raw, binary) => {
      try {
        if (this.entries.get(id) === item)
          sendFrame(agent, binary ? Buffer.from(raw as Buffer) : raw.toString(), binary);
      } catch (error) {
        this.cancel(id, error);
      }
    });
    socket.on("close", () => this.cancel(id, new AppError("cancelled", "Display closed")));
    try {
      sendFrame(agent, JSON.stringify({ type: "start" }));
    } catch (error) {
      this.cancel(id, error);
    }
  }
  private cancelTerminal(item: TerminalChannel, error: unknown) {
    this.sendCancel(item);
    if (item.browser?.readyState === WebSocket.OPEN) {
      if (!item.terminalFinished)
        item.browser.send(JSON.stringify({ type: "error", ...asError(error) }));
      item.browser.close(1000);
    }
    item.agent?.close(1000);
  }

  private acceptFileAgent(item: FileChannel, socket: WebSocket) {
    const { id } = item;
    socket.on("error", () => this.cancel(id, new AppError("offline", "Data connection failed")));
    socket.on("message", (raw, binary) => {
      try {
        if (this.entries.get(id) !== item || item.transfer) return;
        if (binary || item.meta)
          throw new AppError("invalid_argument", "Channel has not been paired");
        const meta = parseReady(raw.toString()) as unknown as FileMeta;
        integer(meta.size, "size", 0, Number.MAX_SAFE_INTEGER);
        const path = string(meta.targetPath, "file target path");
        if (path.startsWith("/") || path.split("/").includes(".."))
          throw new AppError("invalid_argument", "A relative file target path is required");
        if (item.kind === "file.write" && meta.size !== item.params.size)
          throw new AppError("invalid_argument", "Declared file lengths do not match");
        if (
          (item.params.purpose === "image" || item.params.purpose === "open") &&
          ![
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            ...(item.params.purpose === "open" ? ["text/plain; charset=utf-8"] : []),
          ].includes(meta.contentType)
        )
          throw new AppError("unsupported", "Unsupported file content type");
        item.meta = meta;
        clearTimeout(item.timer);
        if (item.download)
          this.content(id, item.loginId, item.download.request, item.download.response);
        else
          item.timer = setTimeout(
            () => this.cancel(id, new AppError("timeout", "Timed out waiting for browser pairing")),
            this.policy.pairingTimeoutMs,
          );
        item.resolve();
      } catch (error) {
        this.cancel(id, error);
      }
    });
    socket.on("close", () => {
      if (item.transfer) void item.transfer.sourceClosed();
      else this.cancel(id, new AppError("offline", "Device data connection closed"));
    });
  }
  content(id: string, loginId: string, request: IncomingMessage, response: ServerResponse) {
    const item = this.entries.get(id);
    if (!item || item.loginId !== loginId)
      throw new AppError("not_found", "File channel not found");
    if (
      (item.kind !== "file.read" && item.kind !== "file.write") ||
      item.transfer ||
      !item.meta ||
      item.agent?.readyState !== WebSocket.OPEN
    )
      throw new AppError("conflict", "File channel cannot be joined");
    if (request.method !== (item.kind === "file.read" ? "GET" : "PUT"))
      throw new AppError("invalid_argument", "File request method mismatch");
    clearTimeout(item.timer);
    item.transfer = new FileTransfer({
      kind: item.kind,
      meta: item.meta,
      socket: item.agent,
      request,
      response,
      fail: (error) => this.cancel(id, error),
      release: () => this.releaseFile(id),
      id,
      purpose: item.params.purpose,
    });
    // start can fail immediately; cancellation must already own the transfer.
    void item.transfer.start();
  }
  private releaseFile(id: string) {
    const item = this.entries.get(id);
    if (!item || (item.kind !== "file.read" && item.kind !== "file.write")) return;
    this.remove(item);
    item.transfer?.finish();
    item.agent?.resume();
    item.agent?.close(1000);
  }
  private cancelFile(item: FileChannel, error: unknown) {
    if (item.kind === "file.read")
      this.notifyFileFailure(item.id, item.loginId, item.connection.id, item.params, error);
    item.transfer?.abort(error);
    this.sendCancel(item);
    item.agent?.terminate();
  }
  private notifyFileFailure(
    id: string,
    loginId: string,
    deviceId: string,
    params: FileReadRequest["params"],
    error: unknown,
  ) {
    this.connections.notify(loginId, {
      type: "channel.failed",
      channelId: id,
      deviceId,
      workspaceId: params.workspaceId,
      path: params.path,
      purpose: params.purpose,
      error: asError(error),
      outcome: "failed",
    });
  }

  createHttp(deviceId: string, login: Login, port: number, failed: (error: unknown) => void) {
    const { entry, message, ready } = this.prepare(deviceId, login, {
      kind: "http.proxy",
      params: { port },
    });
    const item: HttpChannel = { ...entry, kind: "http.proxy", failed };
    this.register(item, message);
    return { id: item.id, ready: ready.then(() => item.stream!) };
  }
  private acceptHttpAgent(item: HttpChannel, socket: WebSocket) {
    const { id } = item;
    socket.on("error", () => this.cancel(id, new AppError("offline", "Data connection failed")));
    const receive = (raw: Buffer, binary: boolean) => {
      try {
        if (this.entries.get(id) !== item) return;
        if (binary) throw new AppError("invalid_argument", "Channel has not been paired");
        parseReady(raw.toString());
        clearTimeout(item.timer);
        socket.off("message", receive);
        item.stream = httpStream(socket, (error) => this.cancel(id, error));
        socket.send(JSON.stringify({ type: "start" }));
        item.resolve();
      } catch (error) {
        this.cancel(id, error);
      }
    };
    socket.on("message", receive);
    socket.on("close", () => {
      if (!item.stream) this.cancel(id, new AppError("offline", "Device data connection closed"));
    });
  }
  finishHttp(id: string) {
    const item = this.entries.get(id);
    if (item?.kind !== "http.proxy") return;
    this.remove(item);
    item.agent?.resume();
    item.agent?.close(1000);
    item.stream?.destroy();
  }
  private cancelHttp(item: HttpChannel, error: unknown) {
    item.failed(error);
    item.stream?.destroy();
    this.sendCancel(item);
    item.agent?.terminate();
  }

  cancel(id: string, error: unknown, loginId?: string) {
    const item = this.entries.get(id);
    if (!item || (loginId !== undefined && item.loginId !== loginId)) return false;
    this.remove(item);
    item.reject(error);
    switch (item.kind) {
      case "terminal.attach":
        this.cancelTerminal(item, error);
        break;
      case "file.read":
      case "file.write":
        this.cancelFile(item, error);
        break;
      case "http.proxy":
        this.cancelHttp(item, error);
        break;
    }
    return true;
  }
  private remove(item: Channel) {
    this.entries.delete(item.id);
    clearTimeout(item.timer);
  }
  private sendCancel(item: Channel) {
    this.connections.send(item.connection.socket, {
      type: "channel.cancel",
      channelId: item.id,
    } satisfies ServerControlMessage);
  }
  close() {
    for (const id of this.entries.keys())
      this.cancel(id, new AppError("offline", "Server is shutting down"));
  }
}
