import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { controlWritable, heartbeat } from "@kiteline/shared/protocol/ws";
import {
  AppError,
  appVersion,
  asError,
  checkShortcutIcon,
  controlCloseCodes,
  errorReply,
  integer,
  limits,
  optionalString,
  record,
  isRpcMethod,
  rpcTraits,
  string,
  type Reply,
  type AgentEvent,
  type AgentControlMessage,
  type ChannelKind,
  type FileProgress,
  type RpcResult,
  type RpcMethod,
} from "@kiteline/shared/protocol";
import type { AgentConfig, Identity } from "./config.js";
import { MetadataStore } from "./metadata.js";
import { Directories } from "./files/directories.js";
import { Sessions } from "./terminal/sessions.js";
import { isSessionMethod, terminalRpc } from "./terminal/rpc.js";
import { LocalServer } from "./local.js";
import { TerminalChannels } from "./terminal/channels.js";
import { Files } from "./files/index.js";
import { TextFiles } from "./files/save.js";
import { FileChannels } from "./files/channels.js";
import { BinaryFiles } from "./files/upload.js";
import { fileRpc, isFileMethod } from "./files/rpc.js";
import { FileOperations } from "./files/operations.js";
import { CursorBudget } from "./cursor-budget.js";
import { Repositories } from "./git/repos.js";
import { WorkspaceWatches } from "./watches.js";
import { GitWriteQueue } from "./git/queue.js";
import { gitRpc, isGitMethod } from "./git/rpc.js";
import { HttpChannels } from "./http/channels.js";
import { listeningPorts } from "./http/ports.js";
import { diagnose } from "./doctor.js";
import { TemporaryFiles } from "./files/temporary.js";
import { connectServer } from "./network.js";
import { ScheduledTasks } from "./tasks/index.js";
import { isScheduleMethod, scheduleRpc } from "./tasks/rpc.js";

const localSessionMethods = new Set<string>([
  "sessions.list",
  "sessions.create",
] satisfies readonly RpcMethod[]);
const reconnectBaseDelayMs = 1000;
const reconnectMaxDelayMs = 30000;
const reconnectJitterMs = 300;

async function readRejection(response: IncomingMessage) {
  let diagnostic = "Check the server URL and reverse proxy.";
  if (response.statusCode === 426)
    diagnostic = "Install the agent version provided by this server.";
  else if (response.statusCode === 401) diagnostic = "Check the device binding and credentials.";
  let serverVersion: string | undefined;
  try {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limits.controlMessageBytes) break;
      parts.push(Buffer.from(chunk));
    }
    const error = record(record(JSON.parse(Buffer.concat(parts).toString())).error);
    diagnostic = string(error.message);
    if (error.code === "version_mismatch")
      serverVersion = string(record(error.details).serverVersion);
  } catch {
    // A reverse proxy may return an HTML error instead of the server diagnostic.
  }
  return { diagnostic, serverVersion };
}

async function finishCleanup(actions: (() => unknown)[], message: string) {
  const results = await Promise.allSettled(actions.map(async (action) => action()));
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.length) throw new AggregateError(errors, message);
}

export class Agent {
  readonly metadata: MetadataStore;
  private readonly cursorBudget = new CursorBudget();
  private readonly directories = new Directories(this.cursorBudget);
  private readonly repos: Repositories;
  readonly watches: WorkspaceWatches;
  readonly gitWrites: GitWriteQueue;
  readonly sessions: Sessions;
  private readonly files: Files;
  private readonly textFiles: TextFiles;
  readonly schedules: ScheduledTasks;
  private readonly temporaryFiles: TemporaryFiles;
  private readonly fileOperations: FileOperations;
  private readonly local: LocalServer;
  private readonly terminalChannels: TerminalChannels;
  private readonly fileChannels: FileChannels;
  private readonly httpChannels: HttpChannels;
  private readonly requests = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  socket?: WebSocket;
  private connectionId?: string;
  private serverVersion?: string;
  private connectionError?: string;
  private reconnect?: NodeJS.Timeout;
  private stopped = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private delay = reconnectBaseDelayMs;
  private readonly notifyWritten = (workspaceId: string) => this.watches.notifyWritten(workspaceId);
  constructor(
    readonly config: AgentConfig,
    private readonly identity: Identity,
  ) {
    this.metadata = new MetadataStore(config, (snapshot) =>
      this.sendEvent({ type: "metadata.snapshot", snapshot }),
    );
    this.schedules = new ScheduledTasks(config, (snapshot) => {
      if (this.connectionId) this.sendEvent({ type: "tasks.snapshot", ...snapshot });
    });
    this.watches = new WorkspaceWatches((event) => this.sendEvent(event));
    this.repos = new Repositories(this.metadata, this.cursorBudget, {
      observed: (workspaceId, repo) => this.watches.repo(workspaceId, repo),
      complete: (workspaceId, ids) => this.watches.reposComplete(workspaceId, ids),
    });
    this.gitWrites = new GitWriteQueue(this.repos);
    this.temporaryFiles = new TemporaryFiles(config.dataDir);
    this.files = new Files(this.metadata, this.directories, this.notifyWritten);
    this.sessions = new Sessions(config, this.metadata, {
      frame: (message) => this.terminalChannels.frame(message),
      notice: (message) => {
        const status = this.send(message);
        if (status === "unavailable")
          console.error(`Terminal report dropped for ${message.sessionId}: server unavailable`);
        else if (status === "too_large")
          console.error(
            `Terminal report dropped for ${message.sessionId}: Control message exceeds the size limit`,
          );
      },
      changed: (workspaceId) =>
        this.sendEvent({ type: "sessions.changed", workspaceId } satisfies AgentEvent),
    });
    this.textFiles = new TextFiles(config, this.metadata, this.temporaryFiles);
    this.fileOperations = new FileOperations(
      this.metadata,
      this.temporaryFiles,
      this.notifyWritten,
    );
    this.terminalChannels = new TerminalChannels(this.sessions, config, identity);
    this.fileChannels = new FileChannels(
      this.textFiles,
      new BinaryFiles(config, this.metadata, this.temporaryFiles),
      this.metadata,
      config,
      identity,
      this.notifyWritten,
    );
    this.httpChannels = new HttpChannels(identity);
    this.local = new LocalServer(config, (method, params, signal) =>
      this.handleLocal(method, params, signal),
    );
  }
  private handleLocal(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped) throw new AppError("cancelled", "Agent is stopping");
    if (method === "doctor")
      return diagnose(this.config, signal, {
        server: this.identity.server,
        connected: this.socket?.readyState === WebSocket.OPEN && !!this.connectionId,
        serverVersion: this.serverVersion,
        connectionError: this.connectionError,
        revision: this.metadata.value.revision,
        shell: this.config.shell,
        recorderPid: this.sessions.recorder.pid,
        sessions: this.sessions.list().sessions,
        schedules: this.schedules.status(),
      });
    if (method === "workspaces.list")
      return Promise.resolve({ workspaces: this.metadata.value.workspaces });
    if (method === "sessions.end")
      return this.sessions.end({ sessionId: string(params.sessionId) });
    if (!localSessionMethods.has(method) && !isScheduleMethod(method))
      throw new AppError("unsupported", "Unsupported local operation");
    return this.dispatch(method, params, signal);
  }
  async start() {
    if (this.stopped) return;
    this.starting ??= this.initialize();
    await this.starting;
  }
  private async initialize() {
    await this.metadata.load();
    if (this.stopped) return;
    await this.temporaryFiles.load();
    if (this.stopped) return;
    await this.schedules.load();
    if (this.stopped) return;
    await this.local.start();
    this.connect();
  }
  private send(message: AgentControlMessage): "sent" | "unavailable" | "too_large" {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > limits.controlMessageBytes) return "too_large";
    if (!this.socket || !controlWritable(this.socket)) return "unavailable";
    this.socket.send(text);
    return "sent";
  }
  private sendEvent(message: Exclude<AgentControlMessage, { type: "rpc.result" }>) {
    if (this.send(message) === "too_large")
      console.error(`Control message dropped (${message.type}): size limit exceeded`);
  }
  private connect() {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = connectServer(
        this.identity,
        "/api/agent/control",
        { appVersion },
        {
          maxPayload: limits.controlMessageBytes,
          handshakeTimeout: limits.interactionTimeout,
        },
      );
    } catch (error) {
      this.connectionError = asError(error).message;
      console.error("Control connection:", this.connectionError);
      this.scheduleReconnect();
      return;
    }
    let failure: string | undefined;
    let unauthorized = false;
    this.socket = socket;
    heartbeat(socket);
    socket.on("open", () => this.sendEvent(this.metadata.hello()));
    socket.on("error", (error) => {
      this.connectionError = failure ??= error.message;
      console.error("Control connection:", error.message);
    });
    socket.on("unexpected-response", (_request, response) => {
      unauthorized = response.statusCode === 401;
      void readRejection(response).then(({ diagnostic, serverVersion }) => {
        if (serverVersion !== undefined) this.serverVersion = serverVersion;
        this.connectionError = failure = `HTTP ${response.statusCode}. ${diagnostic}`;
        console.error("Control connection:", this.connectionError);
        socket.terminate();
      });
    });
    socket.on("message", (raw, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        if (binary) throw new AppError("invalid_argument", "Expected JSON");
        const message = record(JSON.parse(raw.toString()));
        this.handleControlMessage(socket, message);
      } catch (error) {
        console.error(asError(error).message);
        socket.close(1008, "invalid_control_message");
      }
    });
    socket.on("close", (code, reason) => {
      this.connectionError =
        failure ??
        `Control connection closed (${code}${reason.length ? ": " + reason.toString() : ""})`;
      this.connectionId = undefined;
      for (const controller of this.requests.values())
        controller.abort(new AppError("cancelled", "Control connection interrupted"));
      if (this.stopped) return;
      void this.closeConnectionChannels().catch((error: unknown) => console.error(error));
      void this.releaseConnectionCaches().catch((error: unknown) => console.error(error));
      if (
        unauthorized ||
        code === controlCloseCodes.connectionReplaced ||
        code === controlCloseCodes.accessRevoked
      ) {
        console.error(`Remote connection stopped: ${this.connectionError}`);
        return;
      }
      this.scheduleReconnect();
    });
  }
  private handleControlMessage(socket: WebSocket, message: Record<string, unknown>) {
    if (message.type === "welcome") {
      this.serverVersion = string(message.serverVersion);
      this.connectionId = string(message.connectionId);
      this.connectionError = undefined;
      this.delay = reconnectBaseDelayMs;
      this.sendEvent({ type: "tasks.snapshot", ...this.schedules.snapshot() });
    } else if (message.type === "channel.open") {
      if (message.connectionId !== this.connectionId)
        throw new AppError("conflict", "Stale control connection");
      const channelId = string(message.channelId);
      const connectionId = string(message.connectionId);
      const kind = string(message.kind) as ChannelKind;
      const params = record(message.params);
      switch (kind) {
        case "terminal.attach":
          this.terminalChannels.open(channelId, connectionId, params);
          break;
        case "http.proxy":
          this.httpChannels.open(channelId, connectionId, params);
          break;
        case "file.read":
        case "file.write":
          this.fileChannels.open(channelId, connectionId, kind, params);
          break;
        default: {
          const unhandled: never = kind;
          throw new AppError("invalid_argument", `Unknown channel kind: ${unhandled}`);
        }
      }
    } else if (message.type === "channel.cancel") {
      this.terminalChannels.cancel(string(message.channelId));
      this.fileChannels.cancel(string(message.channelId));
      this.httpChannels.cancel(string(message.channelId));
    } else if (message.type === "rpc.request") {
      this.handleRpcRequest(socket, message);
    } else if (message.type === "rpc.cancel")
      this.requests
        .get(string(message.id))
        ?.abort(new AppError("cancelled", "Operation cancelled"));
    else if (message.type === "watch.set") {
      if (!Array.isArray(message.workspaceIds))
        throw new AppError("invalid_argument", "Invalid watches");
      const ids = new Set(message.workspaceIds.map((id) => string(id)));
      const workspaces = this.metadata.value.workspaces.filter((item) => ids.has(item.id));
      void this.repos.retain(new Set(workspaces.map((workspace) => workspace.id)));
      this.watches.set(workspaces);
    }
  }
  private handleRpcRequest(socket: WebSocket, message: Record<string, unknown>) {
    const id = string(message.id, "request id", 128);
    if (this.requests.has(id)) throw new AppError("conflict", "Duplicate request");
    const controller = new AbortController();
    const method = string(message.method);
    const params = record(message.params);
    this.requests.set(id, controller);
    const traits = isRpcMethod(method) ? rpcTraits[method] : undefined;
    const deadline = traits?.deadline;
    const timeout =
      deadline === undefined || deadline === "none"
        ? undefined
        : setTimeout(
            () => controller.abort(new AppError("timeout", "Operation timed out")),
            this.config.limits[deadline],
          );
    void this.dispatch(method, params, controller.signal, (progress) => {
      if (this.socket === socket)
        this.sendEvent({ type: "request.progress", id, ...progress } satisfies AgentEvent);
    })
      .then(
        (result) => ({ id, outcome: "succeeded", result }) as Reply,
        (error: unknown) => errorReply(id, error),
      )
      .then((reply) => {
        if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
          if (this.send({ type: "rpc.result", reply }) === "too_large")
            this.send({
              type: "rpc.result",
              reply: {
                id,
                outcome: reply.outcome === "succeeded" ? traits!.oversizedSuccess : reply.outcome,
                error: {
                  code: "limit_exceeded",
                  message: "Operation result exceeds the size limit; refresh to verify",
                },
              },
            });
        }
      })
      .catch((error: unknown) => console.error(asError(error).message))
      .finally(() => {
        clearTimeout(timeout);
        if (this.requests.get(id) === controller) this.requests.delete(id);
      });
  }
  private scheduleReconnect() {
    this.reconnect = setTimeout(
      () => this.connect(),
      this.delay + Math.random() * reconnectJitterMs,
    );
    this.delay = Math.min(reconnectMaxDelayMs, this.delay * 2);
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    progress?: (value: FileProgress) => void,
  ): Promise<unknown> {
    const operation = this.perform(method, params, signal, progress);
    this.inflight.add(operation);
    void operation.finally(() => this.inflight.delete(operation)).catch(() => {});
    return operation;
  }
  private async perform(
    rawMethod: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    progress?: (value: FileProgress) => void,
  ): Promise<unknown> {
    this.assertRpcActive(signal);
    if (!isRpcMethod(rawMethod))
      throw new AppError("unsupported", `Unsupported operation: ${rawMethod}`);
    const method = rawMethod;
    if (isFileMethod(method))
      return fileRpc(
        method,
        params,
        signal,
        { files: this.files, operations: this.fileOperations, metadata: this.metadata },
        progress,
      );
    if (isGitMethod(method))
      return gitRpc(
        method,
        params,
        signal,
        {
          repos: this.repos,
          writes: this.gitWrites,
          dataDir: this.config.dataDir,
          notifyWritten: this.notifyWritten,
        },
        progress,
      );
    if (isScheduleMethod(method)) return scheduleRpc(this.schedules, method, params, signal);
    if (isSessionMethod(method))
      return terminalRpc(method, params, signal, {
        sessions: this.sessions,
        metadata: this.metadata,
      });
    switch (method) {
      case "ports.list":
        return listeningPorts(signal) satisfies Promise<RpcResult<typeof method>>;
      case "directories.list":
        return this.directories.list(string(params.absolutePath), {
          entries: "absolute",
          cursor: optionalString(params.cursor),
          signal,
        }) satisfies Promise<RpcResult<typeof method>>;
      case "cursors.release": {
        if (params.kind !== "directory" && params.kind !== "repo")
          throw new AppError("invalid_argument", "Invalid cursor kind");
        await (params.kind === "directory" ? this.directories : this.repos).release(
          string(params.id),
        );
        return { released: true } satisfies RpcResult<typeof method>;
      }
      case "directories.mkdir":
        return this.directories.mkdir(string(params.absolutePath), signal) satisfies Promise<
          RpcResult<typeof method>
        >;
      case "workspaces.add":
        return this.metadata.add(
          string(params.absolutePath),
          optionalString(params.name, "name", limits.nameLength),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "workspaces.rename":
        return this.metadata.rename(
          string(params.workspaceId),
          string(params.name, "name", limits.nameLength),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "workspaces.remove": {
        const id = string(params.workspaceId);
        return this.metadata.remove(
          id,
          () => this.sessions.list(id).sessions.length > 0,
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      }
      case "settings.update":
        return this.metadata.updateSettings(
          integer(params.historyLines, "historyLines", 0, limits.terminalHistoryLines),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "shortcuts.put":
        return this.metadata.putShortcut(
          {
            id: optionalString(params.id),
            name: string(params.name, "name", limits.nameLength),
            command: string(params.command, "command", limits.shortcutCommandLength),
            icon: checkShortcutIcon(params.icon),
          },
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "shortcuts.remove":
        return this.metadata.removeShortcut(string(params.id), signal) satisfies Promise<
          RpcResult<typeof method>
        >;
      default: {
        const unhandled: never = method;
        throw new AppError("unsupported", `Unsupported operation: ${unhandled}`);
      }
    }
  }
  private assertRpcActive(signal: AbortSignal) {
    if (this.stopped) throw new AppError("cancelled", "Agent is stopping");
    signal.throwIfAborted();
  }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.schedules.beginClose();
    clearTimeout(this.reconnect);
    for (const controller of this.requests.values())
      controller.abort(new AppError("cancelled", "Agent is stopping"));
    this.socket?.terminate();
    return (this.closing = this.finishClose());
  }
  private closeConnectionChannels() {
    return finishCleanup(
      [
        () => this.terminalChannels.close(),
        () => this.httpChannels.close(),
        () => this.fileChannels.close(),
      ],
      "Connection channel cleanup failed",
    );
  }
  private releaseConnectionCaches() {
    return finishCleanup(
      [() => this.directories.close(), () => this.repos.close(), () => this.watches.close()],
      "Connection cache cleanup failed",
    );
  }
  private async finishClose() {
    await this.starting?.catch(() => {});
    const errors: unknown[] = [];
    const finish = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await Promise.all([
      finish(() => this.sessions.close()),
      finish(() => this.closeConnectionChannels()),
      finish(() => this.local.close()),
      finish(() => this.schedules.close()),
      finish(() => this.fileOperations.close()),
      Promise.allSettled([...this.inflight]),
    ]);
    await finish(() => this.temporaryFiles.close());
    await finish(() => this.releaseConnectionCaches());
    if (errors.length) throw new AggregateError(errors, "Agent cleanup failed");
  }
}
