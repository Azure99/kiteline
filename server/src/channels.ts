import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  AppError,
  asError,
  integer,
  record,
  string,
  type TerminalMeta,
  type FileMeta,
  type ChannelReady,
} from "@kiteline/shared/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { heartbeat, sendFrame } from "@kiteline/shared/ws";
import { httpStream } from "@kiteline/shared/http-stream";
import type { ServerConfig } from "./config.js";
import type { Login } from "./store.js";
import { send, type AgentConnection, type Connections } from "./connections.js";
import { FileTransfer } from "./file-transfer.js";

interface Channel {
  id: string;
  loginId: string;
  connection: AgentConnection;
  timer: NodeJS.Timeout;
  expiresAt: string;
  kind: "terminal.attach" | "file.read" | "file.write" | "http.proxy";
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
  constructor(
    private connections: Connections,
    private config: ServerConfig,
  ) {
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
    if (kind === "terminal.attach") {
      string(params.sessionId);
      string(params.terminalProfile);
      if (
        params.history !== undefined &&
        params.history !== "retained" &&
        params.history !== "screen"
      )
        throw new AppError("invalid_argument", "Invalid history range");
    } else {
      string(params.path);
      if (
        !(
          kind === "file.read"
            ? ["text", "image", ...(download ? ["download"] : [])]
            : ["save", "upload"]
        ).includes(String(params.purpose))
      )
        throw new AppError("unsupported", "Unsupported file purpose");
      if (kind === "file.write") {
        integer(params.size, "size", 0, Number.MAX_SAFE_INTEGER);
        if (typeof params.createOnly !== "boolean")
          throw new AppError("invalid_argument", "Specify whether to create or save the file");
      }
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
          expiresAt: pending.item.expiresAt,
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
    const connection = this.connections.agents.get(deviceId);
    const unavailable = (error: AppError): never => {
      if (kind === "file.read") this.notifyFileFailure(id, login.id, deviceId, params, error);
      throw error;
    };
    if (!connection?.snapshot) return unavailable(new AppError("offline", "Device offline"));
    if (
      [...this.entries.values()].filter((item) => item.connection === connection).length >=
      this.config.limits.channelsPerDevice
    )
      return unavailable(new AppError("busy", "Device channel limit reached"));
    const expiresAt = new Date(Date.now() + this.config.limits.channelPairTimeout).toISOString();
    let item: Channel;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.cancel(id, new AppError("timeout", "Channel pairing timed out")),
        this.config.limits.channelPairTimeout,
      );
      item = {
        id,
        connection,
        loginId: login.id,
        expiresAt,
        kind,
        params,
        timer,
        resolve,
        reject,
        http,
      };
      this.entries.set(id, item);
    });
    send(connection.socket, {
      type: "channel.open",
      channelId: id,
      connectionId: connection.connectionId,
      kind,
      params,
    });
    return { id, ready, item: item! };
  }
  checkAgent(id: string, deviceId: string, connectionId: string) {
    const item = this.entries.get(id);
    if (
      !item ||
      item.agent ||
      item.connection.id !== deviceId ||
      item.connection.connectionId !== connectionId ||
      this.connections.agents.get(deviceId) !== item.connection
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
        if (message.type === "error")
          throw new AppError(string(message.code), string(message.message), message.details);
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
          if (item.kind === "file.write" && meta.size !== item.params.size)
            throw new AppError("invalid_argument", "Declared file lengths do not match");
          if (
            item.params.purpose === "image" &&
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(meta.contentType)
          )
            throw new AppError("unsupported", "Unsupported image type");
        }
        clearTimeout(item.timer);
        item.expiresAt = new Date(Date.now() + this.config.limits.channelPairTimeout).toISOString();
        if (item.download)
          this.content(id, item.loginId, item.download.request, item.download.response);
        else
          item.timer = setTimeout(
            () => this.cancel(id, new AppError("timeout", "Timed out waiting for browser pairing")),
            this.config.limits.channelPairTimeout,
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
    item.file = new FileTransfer(
      item.kind,
      item.meta as FileMeta,
      item.agent,
      request,
      response,
      this.config.limits.channelIdleTimeout,
      (error) => this.cancel(id, error),
      () => this.release(id),
      id,
      String(item.params.purpose),
    );
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
    send(item.connection.socket, { type: "channel.cancel", channelId: id });
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
      workspaceId: params.workspaceId,
      path: params.path,
      purpose: params.purpose,
      error: asError(error),
      outcome: "failed",
    });
  }
}
