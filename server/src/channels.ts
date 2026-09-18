import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { AppError, asError, record, string, type TerminalMeta } from "@kiteline/shared/protocol";
import { heartbeat, sendFrame } from "@kiteline/shared/ws";
import type { ServerConfig } from "./config.js";
import type { Login } from "./store.js";
import { send, type AgentConnection, type Connections } from "./connections.js";

interface Channel {
  id: string;
  loginId: string;
  connection: AgentConnection;
  timer: NodeJS.Timeout;
  expiresAt: string;
  agent?: WebSocket;
  browser?: WebSocket;
  meta?: TerminalMeta;
  terminalFinished?: boolean;
  resolve: (value: { channelId: string; expiresAt: string; meta: TerminalMeta }) => void;
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
          this.cancel(item.id, new AppError("unauthenticated", "登录已结束"));
    };
    connections.onAgentClosed = (connection) => {
      for (const item of this.entries.values())
        if (item.connection === connection)
          this.cancel(item.id, new AppError("offline", "设备连接已中断"));
    };
  }
  create(deviceId: string, login: Login, kind: string, params: Record<string, unknown>) {
    if (kind !== "terminal.attach") throw new AppError("unsupported", "不支持的数据通道");
    string(params.workspaceId);
    string(params.sessionId);
    string(params.terminalProfile);
    if (
      params.history !== undefined &&
      params.history !== "retained" &&
      params.history !== "screen"
    )
      throw new AppError("invalid_argument", "无效历史范围");
    const connection = this.connections.agents.get(deviceId);
    if (!connection?.snapshot) throw new AppError("offline", "设备离线");
    if (
      [...this.entries.values()].filter((item) => item.connection === connection).length >=
      this.config.limits.channelsPerDevice
    )
      throw new AppError("busy", "设备通道已满");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.limits.channelPairTimeout).toISOString();
    const ready = new Promise<{ channelId: string; expiresAt: string; meta: TerminalMeta }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => this.cancel(id, new AppError("timeout", "通道配对超时")),
          this.config.limits.channelPairTimeout,
        );
        this.entries.set(id, {
          id,
          connection,
          loginId: login.id,
          expiresAt,
          timer,
          resolve,
          reject,
        });
      },
    );
    send(connection.socket, {
      type: "channel.open",
      channelId: id,
      connectionId: connection.connectionId,
      kind,
      params,
    });
    return { id, ready };
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
      throw new AppError("forbidden", "数据通道已失效");
  }
  acceptAgent(id: string, socket: WebSocket) {
    const item = this.entries.get(id)!;
    item.agent = socket;
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
        if (binary || item.meta) throw new AppError("invalid_argument", "通道尚未配对");
        const message = record(JSON.parse(raw.toString()));
        if (message.type === "error")
          throw new AppError(string(message.code), string(message.message));
        if (message.type !== "ready") throw new AppError("invalid_argument", "需要通道 ready");
        item.meta = record(message.meta) as unknown as TerminalMeta;
        clearTimeout(item.timer);
        item.expiresAt = new Date(Date.now() + this.config.limits.channelPairTimeout).toISOString();
        item.timer = setTimeout(
          () => this.cancel(id, new AppError("timeout", "等待浏览器配对超时")),
          this.config.limits.channelPairTimeout,
        );
        item.resolve({ channelId: id, expiresAt: item.expiresAt, meta: item.meta });
      } catch (error) {
        this.cancel(id, error);
      }
    });
    socket.on("close", () => this.cancel(id, new AppError("offline", "设备数据连接已关闭")));
  }
  checkBrowser(id: string, loginId: string) {
    const item = this.entries.get(id);
    if (!item || item.loginId !== loginId) throw new AppError("not_found", "数据通道不存在");
    if (item.browser || !item.meta || item.agent?.readyState !== WebSocket.OPEN)
      throw new AppError("conflict", "数据通道不可加入");
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
    socket.on("close", () => this.cancel(id, new AppError("cancelled", "显示已关闭")));
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
    send(item.connection.socket, { type: "channel.cancel", channelId: id });
    if (item.browser?.readyState === WebSocket.OPEN) {
      if (!item.terminalFinished)
        item.browser.send(JSON.stringify({ type: "error", ...asError(error) }));
      item.browser.close(1000);
    }
    item.agent?.close(1000);
    return true;
  }
  close() {
    for (const id of this.entries.keys()) this.cancel(id, new AppError("offline", "服务正在停止"));
  }
}
