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
  type ChannelKind,
  type FileReadPurpose,
  type FileWritePurpose,
  type ServerControlMessage,
} from "@kiteline/shared/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { heartbeat, sendFrame } from "@kiteline/shared/protocol/ws";
import { httpStream } from "@kiteline/shared/protocol/http-stream";
import type { Login } from "./store.js";
import { send, type AgentConnection, type Connections } from "./connections.js";
import { FileTransfer } from "./file-transfer.js";
import { parseReplyError } from "./http.js";

interface Channel {
  id: string;
  loginId: string;
  connection: AgentConnection;
  timer: NodeJS.Timeout;
  kind: ChannelKind;
  params: Record<string, unknown>;
  agent?: WebSocket;
  browser?: WebSocket;
  meta?: TerminalMeta | FileMeta;
  file?: FileTransfer;
  http?: { stream?: Duplex; failed: (error: unknown) => void };
  download?: { request: IncomingMessage; response: ServerResponse };
  terminalFinished?: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}
export class Channels {
  private entries = new Map<string, Channel>();
  constructor(private connections: Connections) {
    connections.onLoginClosed = (loginId) => {
      for (const item of this.entries.values())
        if (item.loginId === loginId)
          this.cancel(item.id, new AppError("unauthenticated", "Login session ended"));
    };
    connections.onAgentClosed = (connection) => {
      for (const item of this.entries.values())
        if (item.connection === connection)
          this.cancel(item.id, new AppError("offline", "Device connection lost"));
    };
  }
  create(
    deviceId: string,
    login: Login,
    kind: string,
    params: Record<string, unknown>,
    download?: { request: IncomingMessage; response: ServerResponse },
  ) {
    if (kind !== "terminal.attach" && kind !== "file.read" && kind !== "file.write")
      throw new AppError("unsupported", "Unsupported data channel");
    string(params.workspaceId);
    if (kind !== "terminal.attach") {
      string(params.path);
      const purposes: readonly string[] =
        kind === "file.read"
          ? ([
              "open",
              "text",
              "image",
              ...(download ? ["download" as const] : []),
            ] satisfies FileReadPurpose[])
          : (["save", "upload"] satisfies FileWritePurpose[]);
      if (!purposes.includes(String(params.purpose)))
        throw new AppError("unsupported", "Unsupported file purpose");
      if (kind === "file.write") integer(params.size, "size", 0, Number.MAX_SAFE_INTEGER);
    }
    const pending = this.reserve(deviceId, login, kind, params);
    if (download) {
      pending.item.download = download;
      download.response.on("close", () => {
        if (!download.response.writableFinished)
          this.cancel(pending.id, new AppError("cancelled", "Download cancelled"));
      });
    }
    return {
      id: pending.id,
      ready: pending.ready.then(
        (): ChannelReady => ({
          channelId: pending.id,
          meta: pending.item.meta!,
        }),
      ),
    };
  }
  createHttp(deviceId: string, login: Login, port: number, failed: (error: unknown) => void) {
    const pending = this.reserve(deviceId, login, "http.proxy", { port }, { failed });
    return { id: pending.id, ready: pending.ready.then(() => pending.item.http!.stream!) };
  }
  private reserve(
    deviceId: string,
    login: Login,
    kind: Channel["kind"],
    params: Record<string, unknown>,
    http?: Channel["http"],
  ) {
    const id = randomUUID();
    const connection = this.connections.online(deviceId);
    const unavailable = (error: AppError): never => {
      if (kind === "file.read") this.notifyFileFailure(id, login.id, deviceId, params, error);
      throw error;
    };
    if (!connection) return unavailable(this.connections.unavailableError(deviceId));
    const message = {
      type: "channel.open",
      channelId: id,
      connectionId: connection.connectionId,
      kind,
      params,
    } satisfies ServerControlMessage;
    if (Buffer.byteLength(JSON.stringify(message)) > limits.controlMessageBytes)
      return unavailable(new AppError("limit_exceeded", "Channel request exceeds the size limit"));
    if (
      [...this.entries.values()].filter((item) => item.connection === connection).length >=
      serverLimits.channelsPerDevice
    )
      return unavailable(new AppError("busy", "Device channel limit reached"));
    let item: Channel;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.cancel(id, new AppError("timeout", "Channel pairing timed out")),
        limits.interactionTimeout,
      );
      item = {
        id,
        connection,
        loginId: login.id,
        kind,
        params,
        timer,
        resolve,
        reject,
        http,
      };
      this.entries.set(id, item);
    });
    send(connection.socket, message);
    return { id, ready, item: item! };
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
    return item.kind;
  }
  acceptAgent(id: string, socket: WebSocket) {
    const item = this.entries.get(id)!;
    item.agent = socket;
    if (item.kind === "terminal.attach") heartbeat(socket);
    else
      socket.on("error", () => this.cancel(id, new AppError("offline", "Data connection failed")));
    const receive = (raw: Buffer, binary: boolean) => {
      try {
        if (this.entries.get(id) !== item) return;
        if (item.file) return;
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
        const message = record(JSON.parse(raw.toString()));
        if (message.type === "error") throw parseReplyError(message);
        if (message.type !== "ready")
          throw new AppError("invalid_argument", "Expected a channel ready message");
        if (item.http) {
          record(message.meta);
          clearTimeout(item.timer);
          socket.off("message", receive);
          item.http.stream = httpStream(socket, (error) => this.cancel(id, error));
          socket.send(JSON.stringify({ type: "start" }));
          item.resolve();
          return;
        }
        item.meta = record(message.meta) as unknown as TerminalMeta | FileMeta;
        if (item.kind !== "terminal.attach") {
          const meta = item.meta as FileMeta;
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
        }
        clearTimeout(item.timer);
        if (item.download)
          this.content(id, item.loginId, item.download.request, item.download.response);
        else
          item.timer = setTimeout(
            () => this.cancel(id, new AppError("timeout", "Timed out waiting for browser pairing")),
            limits.interactionTimeout,
          );
        item.resolve();
      } catch (error) {
        this.cancel(id, error);
      }
    };
    socket.on("message", receive);
    socket.on("close", () => {
      if (item.http?.stream) return;
      if (item.file) {
        void item.file.sourceClosed().then(() => {
          if (this.entries.get(id) === item && !item.file!.sourceComplete)
            this.cancel(id, new AppError("offline", "Device data connection closed"));
        });
      } else this.cancel(id, new AppError("offline", "Device data connection closed"));
    });
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
  }
  content(id: string, loginId: string, request: IncomingMessage, response: ServerResponse) {
    const item = this.entries.get(id);
    if (!item || item.loginId !== loginId)
      throw new AppError("not_found", "File channel not found");
    if (
      (item.kind !== "file.read" && item.kind !== "file.write") ||
      item.file ||
      !item.meta ||
      item.agent?.readyState !== WebSocket.OPEN
    )
      throw new AppError("conflict", "File channel cannot be joined");
    if (request.method !== (item.kind === "file.read" ? "GET" : "PUT"))
      throw new AppError("invalid_argument", "File request method mismatch");
    clearTimeout(item.timer);
    item.file = new FileTransfer({
      kind: item.kind,
      meta: item.meta as FileMeta,
      socket: item.agent,
      request,
      response,
      fail: (error) => this.cancel(id, error),
      release: () => this.release(id),
      id,
      purpose: String(item.params.purpose) as FileReadPurpose | FileWritePurpose,
    });
    void item.file.start();
  }
  private release(id: string) {
    const item = this.entries.get(id);
    if (!item) return;
    this.entries.delete(id);
    clearTimeout(item.timer);
    item.file?.stop();
    item.agent?.resume();
    item.agent?.close(1000);
  }
  finishHttp(id: string) {
    const item = this.entries.get(id);
    if (!item?.http) return;
    this.release(id);
    item.http.stream?.destroy();
  }
  acceptBrowser(id: string, socket: WebSocket) {
    const item = this.entries.get(id)!;
    item.browser = socket;
    clearTimeout(item.timer);
    heartbeat(socket);
    socket.on("message", (raw, binary) => {
      try {
        if (this.entries.get(id) === item)
          sendFrame(item.agent!, binary ? Buffer.from(raw as Buffer) : raw.toString(), binary);
      } catch (error) {
        this.cancel(id, error);
      }
    });
    socket.on("close", () => this.cancel(id, new AppError("cancelled", "Display closed")));
    try {
      sendFrame(item.agent!, JSON.stringify({ type: "start" }));
    } catch (error) {
      this.cancel(id, error);
    }
  }
  cancel(id: string, error: unknown, loginId?: string) {
    const item = this.entries.get(id);
    if (!item || (loginId !== undefined && item.loginId !== loginId)) return false;
    this.entries.delete(id);
    clearTimeout(item.timer);
    item.reject(error);
    item.http?.failed(error);
    item.http?.stream?.destroy();
    if (item.kind === "file.read")
      this.notifyFileFailure(id, item.loginId, item.connection.id, item.params, error);
    item.file?.stop(error);
    send(item.connection.socket, {
      type: "channel.cancel",
      channelId: id,
    } satisfies ServerControlMessage);
    if (item.browser?.readyState === WebSocket.OPEN) {
      if (!item.terminalFinished)
        item.browser.send(JSON.stringify({ type: "error", ...asError(error) }));
      item.browser.close(1000);
    }
    if (item.kind === "terminal.attach") item.agent?.close(1000);
    else item.agent?.terminate();
    return true;
  }
  close() {
    for (const id of this.entries.keys())
      this.cancel(id, new AppError("offline", "Server is shutting down"));
  }
  private notifyFileFailure(
    id: string,
    loginId: string,
    deviceId: string,
    params: Record<string, unknown>,
    error: unknown,
  ) {
    this.connections.notify(loginId, {
      type: "channel.failed",
      channelId: id,
      deviceId,
      workspaceId: params.workspaceId as string,
      path: params.path as string,
      purpose: params.purpose as FileReadPurpose,
      error: asError(error),
      outcome: "failed",
    });
  }
}
