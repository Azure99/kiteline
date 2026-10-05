import { WebSocket } from "ws";
import { controlWritable, heartbeat } from "@kiteline/shared/protocol/ws";
import {
  AppError,
  appVersion,
  asError,
  checkShortcutIcon,
  controlCloseCodes,
  errorReply,
  gitWriteMethods,
  integer,
  limits,
  optionalString,
  record,
  rpcMutates,
  string,
  type Reply,
  type AgentEvent,
  type AgentControlMessage,
  type FileProgress,
  type RpcResult,
  type RpcMethod,
} from "@kiteline/shared/protocol";
import type { AgentConfig, Identity } from "./config.js";
import { MetadataStore } from "./metadata.js";
import { Directories } from "./files/directories.js";
import { Sessions } from "./terminal/sessions.js";
import { LocalServer } from "./local.js";
import { TerminalChannels } from "./terminal/channels.js";
import { Files } from "./files/index.js";
import { TextFiles } from "./files/save.js";
import { FileChannels } from "./files/channels.js";
import { BinaryFiles } from "./files/upload.js";
import { searchFiles } from "./files/search.js";
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

const gitWrites = new Set<string>(gitWriteMethods);
const unboundedMethods = new Set(["files.copy", "files.move", "files.delete"]);
const specializedTimeouts = new Map<string, "searchTimeout" | "gitWriteTimeout">([
  ["files.search", "searchTimeout"],
  ...gitWriteMethods.map((method) => [method, "gitWriteTimeout"] as const),
]);
const notifiedFileMethods = new Set(["files.create", "files.rename"]);
const localSessionMethods = new Set(["sessions.list", "sessions.create"]);

function knownRpcMethod(method: string): RpcMethod {
  if (!Object.hasOwn(rpcMutates, method))
    throw new AppError("unsupported", `Unsupported operation: ${method}`);
  return method as RpcMethod;
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
  readonly requests = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  socket?: WebSocket;
  private connectionId?: string;
  private serverVersion?: string;
  private connectionError?: string;
  private reconnect?: NodeJS.Timeout;
  private stopped = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private delay = 1000;
  constructor(
    readonly config: AgentConfig,
    private readonly identity: Identity,
  ) {
    this.metadata = new MetadataStore(config);
    this.schedules = new ScheduledTasks(config);
    this.schedules.onChange = (snapshot) => {
      if (this.connectionId) this.send({ type: "tasks.snapshot", ...snapshot });
    };
    this.watches = new WorkspaceWatches((event) => this.send(event));
    this.repos = new Repositories(this.metadata, this.cursorBudget);
    this.gitWrites = new GitWriteQueue(this.repos);
    this.repos.onObserved = (workspaceId, repo) => this.watches.repo(workspaceId, repo);
    this.repos.onComplete = (workspaceId, ids) => this.watches.reposComplete(workspaceId, ids);
    this.temporaryFiles = new TemporaryFiles(config.dataDir);
    this.files = new Files(this.metadata, this.directories);
    this.metadata.onChange = (snapshot) => this.send({ type: "metadata.snapshot", snapshot });
    this.sessions = new Sessions(config, this.metadata);
    this.textFiles = new TextFiles(config, this.metadata, this.temporaryFiles);
    this.fileOperations = new FileOperations(this.metadata, this.temporaryFiles, (workspaceId) =>
      this.watches.changed(workspaceId, true),
    );
    this.terminalChannels = new TerminalChannels(this.sessions, config, identity);
    this.fileChannels = new FileChannels(
      this.textFiles,
      new BinaryFiles(config, this.metadata, this.temporaryFiles),
      this.temporaryFiles,
      this.metadata,
      config,
      identity,
      (workspaceId) => this.watches.changed(workspaceId, true),
    );
    this.httpChannels = new HttpChannels(identity);
    this.sessions.onChanged = (workspaceId) =>
      this.send({ type: "sessions.changed", workspaceId } satisfies AgentEvent);
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
    if (method === "terminal.attach") {
      const item = this.sessions.get(string(params.sessionId));
      if (item.session.state !== "running")
        throw new AppError("busy", "Terminal is still being created");
      return Promise.resolve(item.identity);
    }
    if (method === "sessions.end") return this.sessions.end(undefined, string(params.sessionId));
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
  private send(message: AgentControlMessage) {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "Control message exceeds the size limit");
    if (this.socket && controlWritable(this.socket)) this.socket.send(text);
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
    socket.on("open", () => this.send(this.metadata.hello()));
    socket.on("error", (error) => {
      this.connectionError = failure ??= error.message;
      console.error("Control connection:", error.message);
    });
    socket.on("unexpected-response", (_request, response) => {
      unauthorized = response.statusCode === 401;
      const hint =
        response.statusCode === 426
          ? "Install the agent version provided by this server."
          : response.statusCode === 401
            ? "Check the device binding and credentials."
            : "Check the server URL and reverse proxy.";
      void (async () => {
        let diagnostic = hint;
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
            this.serverVersion = string(record(error.details).serverVersion);
        } catch {
          // A reverse proxy may return an HTML error instead of the server diagnostic.
        } finally {
          this.connectionError = failure = `HTTP ${response.statusCode}. ${diagnostic}`;
          console.error("Control connection:", this.connectionError);
          socket.terminate();
        }
      })();
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
      void this.watches.close();
      void this.repos.close();
      this.terminalChannels.close();
      void this.fileChannels.close();
      this.httpChannels.close();
      void this.directories.close();
      if (this.stopped) return;
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
      this.delay = 1000;
      this.send({ type: "tasks.snapshot", ...this.schedules.snapshot() });
    } else if (message.type === "channel.open") {
      if (message.connectionId !== this.connectionId)
        throw new AppError("conflict", "Stale control connection");
      const channels =
        message.kind === "terminal.attach"
          ? this.terminalChannels
          : message.kind === "http.proxy"
            ? this.httpChannels
            : this.fileChannels;
      channels.open(
        string(message.channelId),
        string(message.connectionId),
        string(message.kind),
        record(message.params),
      );
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
    const timeout = unboundedMethods.has(method)
      ? undefined
      : setTimeout(
          () => controller.abort(new AppError("timeout", "Operation timed out")),
          this.config.limits[specializedTimeouts.get(method) ?? "rpcTimeout"],
        );
    void this.dispatch(method, params, controller.signal, (progress) => {
      if (this.socket === socket)
        this.send({ type: "request.progress", id, ...progress } satisfies AgentEvent);
    })
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
                outcome: reply.outcome === "succeeded" ? "unknown" : reply.outcome,
                error: {
                  code: "limit_exceeded",
                  message: "Operation result exceeds the size limit; refresh to verify",
                },
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
  }
  private scheduleReconnect() {
    this.reconnect = setTimeout(() => this.connect(), this.delay + Math.random() * 300);
    this.delay = Math.min(30_000, this.delay * 2);
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    progress?: (value: FileProgress) => void,
  ): Promise<unknown> {
    const operation = this.perform(method, params, signal, progress).finally(() => {
      if (
        (notifiedFileMethods.has(method) || gitWrites.has(method)) &&
        typeof params.workspaceId === "string"
      )
        this.watches.changed(params.workspaceId, true);
    });
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
    if (this.stopped) throw new AppError("cancelled", "Agent is stopping");
    signal.throwIfAborted();
    const method = knownRpcMethod(rawMethod);
    if (isScheduleMethod(method)) return scheduleRpc(this.schedules, method, params, signal);
    if (isGitMethod(method))
      return gitRpc(this.repos, this.gitWrites, method, params, signal, progress);
    switch (method) {
      case "ports.list":
        return listeningPorts(signal) satisfies Promise<RpcResult<typeof method>>;
      case "files.search": {
        if (
          (params.mode !== "name" && params.mode !== "content") ||
          typeof params.includeIgnored !== "boolean"
        )
          throw new AppError("invalid_argument", "Invalid search parameters");
        return searchFiles(
          this.metadata.workspace(string(params.workspaceId)).path,
          params.mode,
          string(params.query, "query"),
          params.includeIgnored,
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      }
      case "files.copy":
      case "files.move":
      case "files.delete":
        return this.fileOperations.run(
          method.slice(6) as "copy" | "move" | "delete",
          string(params.workspaceId),
          method === "files.delete" ? params.paths : params.items,
          signal,
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "files.list": {
        const result = await this.files.list(
          string(params.workspaceId),
          string(params.path),
          optionalString(params.cursor),
          signal,
        );
        return result satisfies RpcResult<typeof method>;
      }
      case "files.inspect":
        return this.files.inspect(
          string(params.workspaceId),
          string(params.path),
          params.suggestCopyName === true,
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "files.create":
        return this.files.create(
          string(params.workspaceId),
          string(params.path),
          string(params.kind),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "files.rename":
        return this.files.rename(
          string(params.workspaceId),
          string(params.path),
          string(params.newName),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "directories.list":
        return this.directories.list(
          string(params.absolutePath),
          optionalString(params.cursor),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
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
      case "sessions.list": {
        const workspaceId = optionalString(params.workspaceId);
        if (workspaceId) this.metadata.workspace(workspaceId);
        return this.sessions.list(workspaceId) satisfies RpcResult<typeof method>;
      }
      case "sessions.create":
        return this.sessions.create(
          string(params.workspaceId),
          optionalString(params.name, "name", limits.nameLength),
          optionalString(params.shortcutId),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "sessions.rename":
        return this.sessions.rename(
          string(params.workspaceId),
          string(params.sessionId),
          string(params.name, "name", limits.nameLength),
        ) satisfies RpcResult<typeof method>;
      case "sessions.end":
        return this.sessions.end(
          string(params.workspaceId),
          string(params.sessionId),
        ) satisfies Promise<RpcResult<typeof method>>;
      case "sessions.recover":
        return this.sessions.recover(
          string(params.workspaceId),
          string(params.sessionId),
        ) satisfies RpcResult<typeof method>;
      case "sessions.redraw":
        return this.sessions.redraw(
          string(params.workspaceId),
          string(params.sessionId),
        ) satisfies Promise<RpcResult<typeof method>>;
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
      finish(() => this.terminalChannels.close()),
      finish(() => this.httpChannels.close()),
      finish(() => this.local.close()),
      finish(() => this.schedules.close()),
      finish(() => this.fileChannels.close()),
      finish(() => this.fileOperations.close()),
      Promise.allSettled([...this.inflight]),
    ]);
    await finish(() => this.temporaryFiles.close());
    await Promise.all([
      finish(() => this.directories.close()),
      finish(() => this.repos.close()),
      finish(() => this.watches.close()),
      finish(() => this.sessions.close()),
    ]);
    if (errors.length) throw new AggregateError(errors, "Agent cleanup failed");
  }
}
