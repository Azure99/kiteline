import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  AppError,
  asError,
  errorReply,
  integer,
  limits,
  record,
  string,
  type Reply,
} from "@kiteline/shared/protocol";
import type { AgentConfig, Identity } from "./config.js";
import { MetadataStore } from "./metadata.js";
import { Directories } from "./directories.js";
import { Sessions } from "./terminals/sessions.js";
import { LocalServer } from "./local.js";
import { TerminalChannels } from "./terminals/channels.js";

export class Agent {
  readonly metadata: MetadataStore;
  readonly directories = new Directories();
  readonly sessions: Sessions;
  private readonly local: LocalServer;
  private readonly channels: TerminalChannels;
  readonly requests = new Map<string, AbortController>();
  readonly watched = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  socket?: WebSocket;
  connectionId?: string;
  private reconnect?: NodeJS.Timeout;
  private stopped = false;
  private delay = 1000;
  constructor(
    readonly config: AgentConfig,
    readonly identity: Identity,
  ) {
    this.metadata = new MetadataStore(config);
    this.metadata.onChange = (snapshot) => this.send({ type: "metadata.snapshot", snapshot });
    this.sessions = new Sessions(config, this.metadata);
    this.channels = new TerminalChannels(this.sessions, config, identity);
    this.sessions.onChanged = (workspaceId) => this.send({ type: "sessions.changed", workspaceId });
    this.local = new LocalServer(config, (method, params, signal) => {
      if (method === "workspaces.list")
        return Promise.resolve({ workspaces: this.metadata.value.workspaces });
      if (method === "terminal.attach") {
        const item = this.sessions.get(string(params.sessionId));
        if (item.session.state !== "running") throw new AppError("busy", "终端仍在创建");
        return Promise.resolve(item.identity);
      }
      if (!["sessions.list", "sessions.create", "sessions.end"].includes(method))
        throw new AppError("unsupported", "不支持的本机操作");
      return this.dispatch(method, params, signal);
    });
  }
  async start() {
    await this.metadata.load();
    await this.local.start();
    this.connect();
  }
  send(message: unknown) {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "控制消息超限");
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > limits.controlMessageBytes * 2) {
      this.socket.close(1013, "control_backpressure");
      return;
    }
    this.socket.send(text);
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL("/api/agent/control?protocolVersion=1", this.identity.server);
    url.protocol = "wss:";
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.identity.deviceToken}` },
      maxPayload: limits.controlMessageBytes,
      handshakeTimeout: this.config.limits.channelPairTimeout,
    });
    this.socket = socket;
    let lastPong = Date.now();
    const ping = setInterval(() => {
      if (Date.now() - lastPong > limits.heartbeatTimeout) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, limits.heartbeatInterval);
    socket.on("pong", () => {
      lastPong = Date.now();
    });
    socket.on("error", (error) => console.error("Control connection:", error.message));
    socket.on("message", (raw, binary) => {
      try {
        if (binary) throw new AppError("invalid_argument", "Expected JSON");
        const message = record(JSON.parse(raw.toString()));
        if (message.type === "welcome") {
          this.connectionId = string(message.connectionId);
          this.delay = 1000;
          this.send(this.metadata.hello());
        } else if (message.type === "channel.open") {
          if (message.connectionId !== this.connectionId)
            throw new AppError("conflict", "旧控制连接");
          this.channels.open(
            string(message.channelId),
            string(message.connectionId),
            string(message.kind),
            record(message.params),
          );
        } else if (message.type === "channel.cancel")
          this.channels.cancel(string(message.channelId));
        else if (message.type === "rpc.request") {
          const id = string(message.id, "request id", 128);
          if (this.requests.has(id)) throw new AppError("conflict", "Duplicate request");
          const controller = new AbortController();
          const method = string(message.method);
          const params = record(message.params);
          this.requests.set(id, controller);
          const timeout = setTimeout(
            () => controller.abort(new AppError("timeout", "操作超时")),
            this.config.limits.rpcTimeout,
          );
          void this.dispatch(method, params, controller.signal)
            .then(
              (result) => ({ id, outcome: "succeeded", result }) as Reply,
              (error: unknown) => errorReply(id, error),
            )
            .then((reply) => {
              if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
                if (
                  Buffer.byteLength(JSON.stringify({ type: "rpc.result", reply })) >
                  limits.controlMessageBytes
                )
                  this.send({
                    type: "rpc.result",
                    reply: {
                      id,
                      outcome: reply.outcome === "succeeded" ? "unknown" : "failed",
                      error: { code: "limit_exceeded", message: "操作结果超过容量，请刷新确认" },
                    },
                  });
                else this.send({ type: "rpc.result", reply });
              }
            })
            .catch((error: unknown) => console.error(asError(error).message))
            .finally(() => {
              clearTimeout(timeout);
              if (this.requests.get(id) === controller) this.requests.delete(id);
            });
        } else if (message.type === "rpc.cancel")
          this.requests.get(string(message.id))?.abort(new AppError("cancelled", "操作已取消"));
        else if (message.type === "watch.set") {
          if (!Array.isArray(message.workspaceIds))
            throw new AppError("invalid_argument", "Invalid watches");
          this.watched.clear();
          for (const id of message.workspaceIds) {
            this.metadata.workspace(string(id));
            this.watched.add(string(id));
          }
        }
      } catch (error) {
        console.error(asError(error).message);
        socket.close(1008, "invalid_control_message");
      }
    });
    socket.on("close", (code, reason) => {
      clearInterval(ping);
      this.connectionId = undefined;
      for (const controller of this.requests.values())
        controller.abort(new AppError("cancelled", "控制连接中断"));
      this.watched.clear();
      this.channels.close();
      void this.directories.close();
      if (this.stopped) return;
      if (code === 4001 || code === 4003) {
        console.error(`Remote connection stopped: ${reason.toString()}`);
        return;
      }
      this.reconnect = setTimeout(() => this.connect(), this.delay + Math.random() * 300);
      this.delay = Math.min(30_000, this.delay * 2);
    });
  }
  dispatch(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const operation = this.perform(method, params, signal);
    this.tasks.add(operation);
    void operation.finally(() => this.tasks.delete(operation)).catch(() => {});
    return operation;
  }
  private async perform(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped) throw new AppError("cancelled", "agent 正在停止");
    signal.throwIfAborted();
    switch (method) {
      case "directories.list":
        return this.directories.list(
          string(params.absolutePath),
          params.cursor === undefined ? undefined : string(params.cursor),
          signal,
        );
      case "directories.mkdir":
        return this.directories.mkdir(string(params.absolutePath), signal);
      case "workspaces.add":
        return this.metadata.add(
          string(params.absolutePath),
          params.name === undefined ? undefined : string(params.name, "name", 256),
          signal,
        );
      case "workspaces.rename": {
        const id = string(params.workspaceId);
        const name = string(params.name, "name", 256);
        return this.metadata.update((metadata) => {
          const workspace = metadata.workspaces.find((w) => w.id === id);
          if (!workspace) throw new AppError("not_found", "workspace 不存在");
          workspace.name = name;
          return workspace;
        }, signal);
      }
      case "workspaces.remove": {
        const id = string(params.workspaceId);
        this.metadata.workspace(id);
        return this.metadata.update((metadata) => {
          if (this.sessions.list(id).sessions.length)
            throw new AppError("busy", "请先结束 workspace 中的终端会话");
          metadata.workspaces = metadata.workspaces.filter((w) => w.id !== id);
          return { removed: true };
        }, signal);
      }
      case "sessions.list": {
        const workspaceId =
          params.workspaceId === undefined ? undefined : string(params.workspaceId);
        if (workspaceId) this.metadata.workspace(workspaceId);
        return this.sessions.list(workspaceId);
      }
      case "sessions.create":
        return this.sessions.create(
          string(params.workspaceId),
          params.name === undefined ? undefined : string(params.name, "name", 256),
          params.shortcutId === undefined ? undefined : string(params.shortcutId),
          signal,
        );
      case "sessions.rename":
        return this.sessions.rename(
          string(params.workspaceId),
          string(params.sessionId),
          string(params.name, "name", 256),
        );
      case "sessions.end":
        return this.sessions.end(
          params.workspaceId === undefined ? undefined : string(params.workspaceId),
          string(params.sessionId),
        );
      case "sessions.recover":
        return this.sessions.recover(string(params.workspaceId), string(params.sessionId));
      case "sessions.redraw":
        return this.sessions.redraw(string(params.workspaceId), string(params.sessionId));
      case "settings.update": {
        const historyLines = integer(params.historyLines, "historyLines", 0, 50_000);
        return this.metadata.update((metadata) => {
          metadata.settings.historyLines = historyLines;
          return metadata.settings;
        }, signal);
      }
      case "shortcuts.put": {
        const id = params.id === undefined ? randomUUID() : string(params.id);
        const name = string(params.name, "name", 256);
        const command = string(params.command, "command", 65536);
        return this.metadata.update((metadata) => {
          const previous = metadata.shortcuts.find((item) => item.id === id);
          if (params.id !== undefined && !previous)
            throw new AppError("not_found", "快捷方式不存在");
          const shortcut = { id, name, command };
          if (previous) Object.assign(previous, shortcut);
          else metadata.shortcuts.push(shortcut);
          return shortcut;
        }, signal);
      }
      case "shortcuts.remove": {
        const id = string(params.id);
        return this.metadata.update((metadata) => {
          metadata.shortcuts = metadata.shortcuts.filter((item) => item.id !== id);
          return { removed: true };
        }, signal);
      }
      default:
        throw new AppError("unsupported", `不支持的操作: ${method}`);
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.socket?.terminate();
    this.channels.close();
    for (const controller of this.requests.values())
      controller.abort(new AppError("cancelled", "agent 正在停止"));
    await this.local.close();
    await Promise.allSettled([...this.tasks]);
    await this.directories.close();
    await this.sessions.close();
  }
}
