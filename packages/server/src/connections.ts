import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { controlWritable, heartbeat } from "@kiteline/shared/protocol/ws";
import {
  AppError,
  appVersion,
  checkMetadata,
  checkEnvironment,
  controlCloseCodes,
  integer,
  limits,
  record,
  reportKey,
  string,
  type ServerControlMessage,
  type AgentControlMessage,
  type BrowserEvent,
  type BrowserControlMessage,
  type WorkspaceEvent,
  type Metadata,
  type Device,
  type Reply,
} from "@kiteline/shared/protocol";
import type { Login, Store } from "./store.js";
import {
  checkReply,
  permitsDevice,
  requireDevice,
  requireVersion,
  serverError,
  versionMismatch,
} from "./http.js";
import { projectTaskSnapshot } from "./task-summary.js";
import { Channels } from "./channels.js";

export interface AgentConnection {
  id: string;
  connectionId: string;
  socket: WebSocket;
  snapshot?: Metadata;
  editorBytes?: number;
  environment?: Device["environment"];
  taskRevision?: number;
}
type OnlineAgentConnection = AgentConnection &
  Required<Pick<AgentConnection, "snapshot" | "editorBytes" | "environment">>;
interface Pending {
  loginId: string;
  connection: AgentConnection;
  resolve: (reply: Reply) => void;
}
interface Browser {
  socket: WebSocket;
  login: Login;
  targets: Extract<BrowserControlMessage, { type: "watch.set" }>["targets"];
  syncing?: boolean;
}

type Report = Extract<BrowserEvent, { type: "terminal.notice" }>;

export class Connections {
  readonly channels = new Channels(this);
  private readonly reports = new Map<string, Report>();
  private readonly agents = new Map<string, OnlineAgentConnection>();
  private readonly handshakes = new Set<AgentConnection>();
  private readonly releases = new Map<string, NonNullable<Device["release"]>>();
  private readonly browsers = new Set<Browser>();
  private readonly pending = new Map<string, Pending>();
  private readonly expiry: NodeJS.Timeout;

  constructor(private store: Store) {
    this.expiry = setInterval(() => {
      for (const { id } of this.store.expiredLogins()) {
        // Expiry already invalidated the login; deleting its row only clears persisted state.
        this.closeLogin(id);
        this.store.logout(id);
      }
    }, 1000);
    this.expiry.unref();
  }
  send(socket: WebSocket, value: ServerControlMessage | BrowserEvent) {
    if (controlWritable(socket)) socket.send(JSON.stringify(value));
  }
  online(deviceId: string) {
    return this.agents.get(deviceId);
  }
  devices(login?: Login) {
    return this.store
      .devices()
      .filter((device) => !login || permitsDevice(login, device.id))
      .map((device) => {
        const connection = this.agents.get(device.id);
        const known = { ...device, release: this.releases.get(device.id) };
        return connection
          ? {
              ...known,
              status: "online" as const,
              snapshot: connection.snapshot,
              editorBytes: connection.editorBytes,
              environment: connection.environment,
            }
          : known;
      });
  }
  observeAndRequireAgentVersion(id: string, version: string | null) {
    if (!this.agents.has(id)) {
      this.releases.set(id, {
        agentVersion: version,
        serverVersion: appVersion,
        observedAt: new Date().toISOString(),
      });
      this.broadcastDevices();
    }
    requireVersion(version, "agent");
  }
  unavailableError(id: string) {
    const release = this.releases.get(id);
    if (release && release.agentVersion !== appVersion)
      return versionMismatch(release.agentVersion, "agent");
    return new AppError("offline", "Device offline");
  }
  private broadcastDevices() {
    if (this.browsers.size === 0) return;
    const devices = this.devices();
    for (const browser of this.browsers)
      this.send(browser.socket, {
        type: "devices.changed",
        devices: devices.filter((device) => permitsDevice(browser.login, device.id)),
      });
  }
  taskSummaries(login: Login, deviceId?: string) {
    return this.store
      .taskSummaries(deviceId)
      .filter((item) => permitsDevice(login, item.deviceId))
      .map((item) => ({
        ...item,
        current: this.agents.get(item.deviceId)?.taskRevision !== undefined,
      }));
  }
  notify(loginId: string, event: BrowserEvent) {
    for (const browser of this.browsers)
      if (browser.login.id === loginId) this.send(browser.socket, event);
  }
  acceptAgent(id: string, socket: WebSocket) {
    const connection: AgentConnection = { id, connectionId: randomUUID(), socket };
    this.handshakes.add(connection);
    heartbeat(socket);
    const helloTimeout = setTimeout(() => {
      this.handshakes.delete(connection);
      socket.close(1008, "hello_timeout");
    }, 30_000);
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new AppError("invalid_argument", "Expected JSON control frame");
        const message = record(JSON.parse(data.toString()));
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!this.handshakes.has(connection) && this.agents.get(id) !== connection) return;
        const type = message.type as AgentControlMessage["type"];
        if (type === "hello") {
          if (connection.snapshot) throw new AppError("unsupported", "Invalid hello");
          const online = Object.assign(connection, {
            environment: checkEnvironment(message.environment),
            editorBytes: integer(message.editorBytes, "editorBytes", 1, Number.MAX_SAFE_INTEGER),
            snapshot: checkMetadata(message.snapshot),
          });
          clearTimeout(helloTimeout);
          this.handshakes.delete(connection);
          const previous = this.agents.get(id);
          if (previous) {
            this.dropAgent(previous);
            previous.socket.close(controlCloseCodes.connectionReplaced, "connection_replaced");
          }
          this.agents.set(id, online);
          this.releases.set(id, {
            agentVersion: appVersion,
            serverVersion: appVersion,
            observedAt: new Date().toISOString(),
          });
          this.store.saveSnapshot(id, online.snapshot);
          this.store.recordConnectedAt(id);
          this.send(socket, {
            type: "welcome",
            connectionId: connection.connectionId,
            serverVersion: appVersion,
          } satisfies ServerControlMessage);
          this.broadcastDevices();
          this.updateWatch(id);
          return;
        }
        if (!connection.snapshot) throw new AppError("invalid_argument", "hello required");
        switch (type) {
          case "metadata.snapshot": {
            const snapshot = checkMetadata(message.snapshot);
            if (snapshot.revision > connection.snapshot.revision) {
              connection.snapshot = snapshot;
              this.store.saveSnapshot(id, snapshot);
              this.broadcastDevices();
            }
            break;
          }
          case "tasks.snapshot": {
            const snapshot = projectTaskSnapshot(message);
            if (
              connection.taskRevision === undefined ||
              snapshot.revision > connection.taskRevision
            ) {
              connection.taskRevision = snapshot.revision;
              this.store.saveTaskSnapshot(id, snapshot);
              for (const browser of this.browsers)
                if (permitsDevice(browser.login, id))
                  this.send(browser.socket, {
                    type: "tasks.changed",
                    deviceId: id,
                  } satisfies BrowserEvent);
            }
            break;
          }
          case "rpc.result": {
            const reply = record(message.reply);
            const requestId = string(reply.id, "request id", 128);
            const pending = this.pending.get(requestId);
            if (pending?.connection === connection) {
              const checked = checkReply(reply);
              this.pending.delete(requestId);
              pending.resolve(checked);
            }
            break;
          }
          case "terminal.notice": {
            const notice = record(message.notice);
            if (
              typeof notice.title !== "string" ||
              typeof notice.body !== "string" ||
              typeof notice.blocked !== "boolean"
            )
              throw new AppError("invalid_argument", "Invalid terminal report");
            const event: BrowserEvent = {
              type: "terminal.notice",
              noticeId: randomUUID(),
              receivedAt: Date.now(),
              deviceId: id,
              workspaceId: string(message.workspaceId),
              sessionId: string(message.sessionId),
              name: string(message.name, "session name", limits.nameLength),
              notice: { title: notice.title, body: notice.body, blocked: notice.blocked },
            };
            const text = JSON.stringify(event);
            if (Buffer.byteLength(text) > limits.controlMessageBytes) {
              console.error(`Terminal report dropped for ${id}: control message exceeds limit`);
              break;
            }
            this.reports.set(reportKey(event), event);
            for (const browser of this.browsers) {
              if (!permitsDevice(browser.login, id)) continue;
              if (controlWritable(browser.socket)) browser.socket.send(text);
              else console.error(`Terminal report dropped for ${id}: browser unavailable`);
            }
            break;
          }
          case "request.progress": {
            const requestId = string(message.id);
            const pending = this.pending.get(requestId);
            if (pending?.connection === connection) {
              const { phase, currentPath, completedItems, bytes } = message;
              if (
                (phase !== "queued" && phase !== "running") ||
                (currentPath !== undefined && typeof currentPath !== "string") ||
                (completedItems !== undefined && typeof completedItems !== "number") ||
                (bytes !== undefined && typeof bytes !== "number")
              )
                throw new AppError("invalid_argument", "Invalid request progress");
              this.notify(pending.loginId, {
                type: "request.progress",
                id: requestId,
                deviceId: id,
                phase,
                currentPath,
                completedItems,
                bytes,
              });
            }
            break;
          }
          case "workspace.changed":
          case "sessions.changed":
          case "watch.status": {
            const workspaceId = string(message.workspaceId);
            let event: WorkspaceEvent;
            if (message.type === "workspace.changed") {
              event = { type: "workspace.changed", workspaceId };
            } else if (message.type === "sessions.changed") {
              event = { type: "sessions.changed", workspaceId };
            } else {
              const { status, reason } = message;
              if (
                (status !== "normal" && status !== "degraded") ||
                (reason !== undefined && typeof reason !== "string")
              )
                throw new AppError("invalid_argument", "Invalid workspace watch status");
              event = { type: "watch.status", workspaceId, status, reason };
            }
            for (const browser of this.browsers)
              if (browser.targets.some((t) => t.deviceId === id && t.workspaceId === workspaceId))
                this.send(browser.socket, { ...event, deviceId: id });
            break;
          }
          default:
            return void (type satisfies never);
        }
      } catch (error) {
        serverError(error);
        socket.close(1008, "invalid_control_message");
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimeout);
      this.handshakes.delete(connection);
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
    this.channels.cancelConnection(connection, new AppError("offline", "Device connection lost"));
    this.broadcastDevices();
  }
  activateReport(deviceId: string, workspaceId: string, sessionId: string) {
    const current = this.reports.get(reportKey({ deviceId, workspaceId, sessionId }));
    if (current) this.clearReport(current);
  }
  private clearReport(report: Report) {
    this.reports.delete(reportKey(report));
    const { deviceId, workspaceId, sessionId, noticeId } = report;
    for (const browser of this.browsers)
      if (permitsDevice(browser.login, deviceId))
        this.send(browser.socket, {
          type: "notice.cleared",
          deviceId,
          workspaceId,
          sessionId,
          noticeId,
        });
  }
  private syncReports(browser: Browser) {
    if (browser.syncing) return;
    browser.syncing = true;
    this.send(browser.socket, { type: "notices.reset" });
    const keys = [...this.reports.keys()];
    let cursor = 0;
    const next = () => {
      while (cursor < keys.length) {
        const report = this.reports.get(keys[cursor++]!);
        if (!report || !permitsDevice(browser.login, report.deviceId)) continue;
        if (!controlWritable(browser.socket)) {
          browser.syncing = false;
          return;
        }
        browser.socket.send(JSON.stringify(report), (error) => {
          if (error) {
            browser.syncing = false;
            console.error(error);
            browser.socket.close(1011, "snapshot_send_failed");
          } else next();
        });
        return;
      }
      browser.syncing = false;
    };
    next();
  }
  acceptBrowser(socket: WebSocket, login: Login) {
    const browser: Browser = { socket, login, targets: [] };
    this.browsers.add(browser);
    heartbeat(socket);
    this.send(socket, {
      type: "devices.changed",
      devices: this.devices(login),
    } satisfies BrowserEvent);
    this.syncReports(browser);
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Expected JSON");
        const message = record(JSON.parse(data.toString()));
        if (socket.readyState !== WebSocket.OPEN) return;
        if (message.type === "notices.sync") return this.syncReports(browser);
        if (
          message.type !== "watch.set" ||
          !Array.isArray(message.targets) ||
          message.targets.length > 128
        )
          throw new Error("Invalid watch");
        const previous = browser.targets;
        browser.targets = message.targets.map((value) => {
          const item = record(value);
          const deviceId = string(item.deviceId);
          requireDevice(login, deviceId);
          return { deviceId, workspaceId: string(item.workspaceId) };
        });
        for (const id of new Set([...previous, ...browser.targets].map((t) => t.deviceId)))
          this.updateWatch(id);
      } catch {
        socket.close(1008, "invalid_event_message");
      }
    });
    socket.on("close", () => {
      browser.syncing = false;
      this.browsers.delete(browser);
      for (const { deviceId } of browser.targets) this.updateWatch(deviceId);
    });
  }
  private updateWatch(deviceId: string) {
    const connection = this.agents.get(deviceId);
    if (!connection) return;
    const workspaceIds = new Set<string>();
    for (const browser of this.browsers)
      for (const target of browser.targets)
        if (
          target.deviceId === deviceId &&
          connection.snapshot.workspaces.some((w) => w.id === target.workspaceId)
        )
          workspaceIds.add(target.workspaceId);
    this.send(connection.socket, {
      type: "watch.set",
      workspaceIds: [...workspaceIds],
    } satisfies ServerControlMessage);
  }
  rpc(
    deviceId: string,
    login: Login,
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ) {
    const connection = this.agents.get(deviceId);
    if (!connection) throw this.unavailableError(deviceId);
    if (this.pending.has(requestId)) throw new AppError("conflict", "Request ID already exists");
    if (
      [...this.pending.values()].filter((p) => p.connection === connection).length >=
      limits.pendingRequestsPerDevice
    )
      throw new AppError("busy", "Too many pending requests for this device");
    const message = {
      type: "rpc.request",
      id: requestId,
      method,
      params,
    } satisfies ServerControlMessage;
    if (Buffer.byteLength(JSON.stringify(message)) > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "Request exceeds the size limit");
    return new Promise<Reply>((resolve) => {
      this.pending.set(requestId, { loginId: login.id, connection, resolve });
      this.send(connection.socket, message);
    });
  }
  cancel(deviceId: string, requestId: string, loginId: string) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.loginId !== loginId || pending.connection.id !== deviceId) return false;
    this.send(pending.connection.socket, {
      type: "rpc.cancel",
      id: requestId,
    } satisfies ServerControlMessage);
    return true;
  }
  logout(loginId: string) {
    this.store.logout(loginId);
    this.closeLogin(loginId);
  }
  revokeCredential(id: string) {
    const revoked = this.store.revokeCredential(id);
    if (revoked) this.closeLogin(id);
    return revoked;
  }
  private closeLogin(loginId: string) {
    this.channels.cancelLogin(loginId, new AppError("unauthenticated", "Login session ended"));
    for (const browser of this.browsers)
      if (browser.login.id === loginId)
        browser.socket.close(controlCloseCodes.accessRevoked, "session_expired");
    for (const [id, pending] of this.pending)
      if (pending.loginId === loginId) this.cancel(pending.connection.id, id, loginId);
  }
  bind(code: string, name: string) {
    const identity = this.store.bind(code, name);
    this.broadcastDevices();
    return identity;
  }
  renameDevice(deviceId: string, name: string) {
    this.store.renameDevice(deviceId, name);
    this.broadcastDevices();
  }
  deleteDevice(deviceId: string) {
    this.store.deleteDevice(deviceId);
    for (const report of this.reports.values())
      if (report.deviceId === deviceId) this.clearReport(report);
    this.releases.delete(deviceId);
    for (const candidate of this.handshakes)
      if (candidate.id === deviceId) {
        this.handshakes.delete(candidate);
        candidate.socket.close(controlCloseCodes.accessRevoked, "device_deleted");
      }
    const connection = this.agents.get(deviceId);
    if (connection) {
      this.dropAgent(connection);
      connection.socket.close(controlCloseCodes.accessRevoked, "device_deleted");
    } else this.broadcastDevices();
  }
  close() {
    this.channels.close();
    clearInterval(this.expiry);
    for (const browser of this.browsers) browser.socket.terminate();
    for (const candidate of this.handshakes) candidate.socket.terminate();
    this.handshakes.clear();
    for (const connection of [...this.agents.values()]) {
      this.dropAgent(connection);
      connection.socket.terminate();
    }
  }
}
