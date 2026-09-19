import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { heartbeat } from "@kiteline/shared/ws";
import {
  AppError,
  checkMetadata,
  integer,
  limits,
  record,
  string,
  type AgentEvent,
  type BrowserEvent,
  type WorkspaceEvent,
  type Metadata,
  type Reply,
} from "@kiteline/shared/protocol";
import type { Login, Store } from "./store.js";

export interface AgentConnection {
  id: string;
  connectionId: string;
  socket: WebSocket;
  snapshot?: Metadata;
  editorBytes?: number;
}
interface Pending {
  loginId: string;
  connection: AgentConnection;
  resolve: (reply: Reply) => void;
}
interface Browser {
  socket: WebSocket;
  login: Login;
  targets: { deviceId: string; workspaceId: string }[];
}

export function send(socket: WebSocket, value: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > limits.controlMessageBytes * 2) {
    socket.close(1013, "control_backpressure");
    return;
  }
  socket.send(JSON.stringify(value));
}
export class Connections {
  readonly agents = new Map<string, AgentConnection>();
  private readonly browsers = new Set<Browser>();
  private readonly pending = new Map<string, Pending>();
  private readonly expiry: NodeJS.Timeout;
  onLoginClosed?: (loginId: string) => void;
  onAgentClosed?: (connection: AgentConnection) => void;

  constructor(private store: Store) {
    this.expiry = setInterval(() => {
      for (const { id } of this.store.expiredSessions()) {
        this.closeLogin(id);
        this.store.logout(id);
      }
    }, 1000);
    this.expiry.unref();
  }
  devices() {
    return this.store.devices().map((device) => {
      const connection = this.agents.get(device.id);
      return connection?.snapshot
        ? {
            ...device,
            status: "online" as const,
            snapshot: connection.snapshot,
            editorBytes: connection.editorBytes,
          }
        : device;
    });
  }
  broadcastDevices() {
    const event = { type: "devices.changed", devices: this.devices() } satisfies BrowserEvent;
    for (const browser of this.browsers) send(browser.socket, event);
  }
  notify(loginId: string, event: BrowserEvent) {
    for (const browser of this.browsers)
      if (browser.login.id === loginId) send(browser.socket, event);
  }
  acceptAgent(id: string, socket: WebSocket) {
    const previous = this.agents.get(id);
    if (previous) {
      this.dropAgent(previous);
      previous.socket.close(4001, "connection_replaced");
    }
    const connection: AgentConnection = { id, connectionId: randomUUID(), socket };
    this.agents.set(id, connection);
    heartbeat(socket);
    send(socket, { type: "welcome", connectionId: connection.connectionId });
    const helloTimeout = setTimeout(() => socket.close(1008, "hello_timeout"), 30_000);
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new AppError("invalid_argument", "Expected JSON control frame");
        const message = record(JSON.parse(data.toString()));
        if (this.agents.get(id) !== connection) return;
        if (message.type === "hello") {
          if (message.protocolVersion !== 1 || connection.snapshot)
            throw new AppError("unsupported", "Invalid hello");
          connection.editorBytes = integer(
            message.editorBytes,
            "editorBytes",
            1,
            Number.MAX_SAFE_INTEGER,
          );
          connection.snapshot = checkMetadata(message.snapshot);
          clearTimeout(helloTimeout);
          this.store.snapshot(id, connection.snapshot);
          this.store.connected(id);
          this.broadcastDevices();
          this.updateWatch(id);
        } else if (!connection.snapshot) throw new AppError("invalid_argument", "hello required");
        else if (message.type === "metadata.snapshot") {
          const snapshot = checkMetadata(message.snapshot);
          if (snapshot.revision > connection.snapshot.revision) {
            connection.snapshot = snapshot;
            this.store.snapshot(id, snapshot);
            this.broadcastDevices();
          }
        } else if (message.type === "rpc.result") {
          const reply = record(message.reply);
          const requestId = string(reply.id, "request id", 128);
          const pending = this.pending.get(requestId);
          if (pending?.connection === connection) {
            if (!["succeeded", "failed", "partial", "unknown"].includes(String(reply.outcome)))
              throw new AppError("invalid_argument", "Invalid reply");
            if (reply.outcome !== "succeeded") {
              const error = record(reply.error);
              string(error.code);
              string(error.message);
            }
            this.pending.delete(requestId);
            pending.resolve(reply as unknown as Reply);
          }
        } else if (message.type === "request.progress") {
          const pending = this.pending.get(string(message.id));
          if (pending?.connection === connection)
            this.notify(pending.loginId, {
              ...(message as unknown as Extract<AgentEvent, { type: "request.progress" }>),
              deviceId: id,
            });
        } else if (
          ["workspace.changed", "sessions.changed", "watch.status"].includes(String(message.type))
        ) {
          const workspaceId = string(message.workspaceId);
          const event = { ...(message as WorkspaceEvent), deviceId: id } satisfies BrowserEvent;
          for (const browser of this.browsers)
            if (browser.targets.some((t) => t.deviceId === id && t.workspaceId === workspaceId))
              send(browser.socket, event);
        }
      } catch {
        socket.close(1008, "invalid_control_message");
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimeout);
      this.dropAgent(connection);
    });
  }
  private dropAgent(connection: AgentConnection) {
    if (this.agents.get(connection.id) !== connection) return;
    this.agents.delete(connection.id);
    for (const [id, pending] of this.pending)
      if (pending.connection === connection) {
        this.pending.delete(id);
        pending.resolve({
          id,
          outcome: "unknown",
          error: {
            code: "offline",
            message: "Device connection lost; operation outcome is unknown",
          },
        });
      }
    this.onAgentClosed?.(connection);
    this.broadcastDevices();
  }
  acceptBrowser(socket: WebSocket, login: Login) {
    const browser: Browser = { socket, login, targets: [] };
    this.browsers.add(browser);
    heartbeat(socket);
    send(socket, { type: "devices.changed", devices: this.devices() } satisfies BrowserEvent);
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Expected JSON");
        const message = record(JSON.parse(data.toString()));
        if (
          message.type !== "watch.set" ||
          !Array.isArray(message.targets) ||
          message.targets.length > 128
        )
          throw new Error("Invalid watch");
        const previous = browser.targets;
        browser.targets = message.targets.map((value) => {
          const item = record(value);
          return { deviceId: string(item.deviceId), workspaceId: string(item.workspaceId) };
        });
        for (const id of new Set([...previous, ...browser.targets].map((t) => t.deviceId)))
          this.updateWatch(id);
      } catch {
        socket.close(1008, "invalid_event_message");
      }
    });
    socket.on("close", () => {
      this.browsers.delete(browser);
      for (const { deviceId } of browser.targets) this.updateWatch(deviceId);
    });
  }
  private updateWatch(deviceId: string) {
    const connection = this.agents.get(deviceId);
    if (!connection?.snapshot) return;
    const workspaceIds = new Set<string>();
    for (const browser of this.browsers)
      for (const target of browser.targets)
        if (
          target.deviceId === deviceId &&
          connection.snapshot.workspaces.some((w) => w.id === target.workspaceId)
        )
          workspaceIds.add(target.workspaceId);
    send(connection.socket, { type: "watch.set", workspaceIds: [...workspaceIds] });
  }
  rpc(
    deviceId: string,
    login: Login,
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ) {
    const connection = this.agents.get(deviceId);
    if (!connection?.snapshot) throw new AppError("offline", "Device offline");
    if (this.pending.has(requestId)) throw new AppError("conflict", "Request ID already exists");
    if (
      [...this.pending.values()].filter((p) => p.connection === connection).length >=
      limits.pendingRequestsPerDevice
    )
      throw new AppError("busy", "Too many pending requests for this device");
    const message = { type: "rpc.request", id: requestId, method, params };
    if (Buffer.byteLength(JSON.stringify(message)) > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "Request exceeds the size limit");
    return new Promise<Reply>((resolve) => {
      this.pending.set(requestId, { loginId: login.id, connection, resolve });
      send(connection.socket, message);
    });
  }
  cancel(deviceId: string, requestId: string, loginId: string) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.loginId !== loginId || pending.connection.id !== deviceId) return false;
    send(pending.connection.socket, { type: "rpc.cancel", id: requestId });
    return true;
  }
  closeLogin(loginId: string) {
    this.onLoginClosed?.(loginId);
    for (const browser of this.browsers)
      if (browser.login.id === loginId) browser.socket.close(4003, "session_expired");
    for (const [id, pending] of this.pending)
      if (pending.loginId === loginId) this.cancel(pending.connection.id, id, loginId);
  }
  revoke(deviceId: string) {
    this.store.revokeDevice(deviceId);
    const connection = this.agents.get(deviceId);
    if (connection) {
      this.dropAgent(connection);
      connection.socket.close(4003, "device_revoked");
    }
    this.broadcastDevices();
  }
  close() {
    clearInterval(this.expiry);
    for (const browser of this.browsers) browser.socket.terminate();
    for (const connection of [...this.agents.values()]) {
      this.dropAgent(connection);
      connection.socket.terminate();
    }
  }
}
export function bearer(request: IncomingMessage) {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer "))
    throw new AppError("unauthenticated", "Missing device credentials");
  return value.slice(7);
}
