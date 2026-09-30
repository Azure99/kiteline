import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  AppError,
  appVersion,
  asError,
  checkShortcutIcon,
  errorReply,
  integer,
  limits,
  protocolVersion,
  record,
  rpcMutates,
  string,
  type Reply,
  type AgentEvent,
  type FileProgress,
  type RpcResult,
  type RpcMethod,
} from "@kiteline/shared/protocol";
import { privateDirectory, type AgentConfig, type Identity } from "./config.js";
import { MetadataStore } from "./metadata.js";
import { Directories } from "./directories.js";
import { Sessions } from "./terminals/sessions.js";
import { LocalServer } from "./local.js";
import { TerminalChannels } from "./terminals/channels.js";
import { Files } from "./files/index.js";
import { TextFiles } from "./files/text.js";
import { FileChannels } from "./files/channels.js";
import { BinaryFiles } from "./files/binary.js";
import { searchFiles } from "./files/search.js";
import { FileOperations } from "./files/operations.js";
import { CursorBudget } from "./cursor-budget.js";
import { Repositories } from "./git/repos.js";
import { status } from "./git/status.js";
import { workingDiff } from "./git/diff.js";
import { branches, commitDiff, commitFiles, history } from "./git/history.js";
import { WorkspaceWatches } from "./watches.js";
import { GitWriteQueue } from "./git/queue.js";
import { changeIndex, discard, discardScope, gitPaths, reviewDiscard } from "./git/paths.js";
import { changeBranch, commit, createBranch } from "./git/refs.js";
import { expectedHead, remotes, syncRemote } from "./git/remotes.js";
import { finishOperation } from "./git/operation.js";
import { HttpChannels } from "./http/channels.js";
import { listeningPorts } from "./http/ports.js";
import { diagnose } from "./doctor.js";
import { TemporaryFiles } from "./files/temporary.js";
import { connectServerSocket } from "./network.js";
import { ScheduledTasks } from "./tasks/index.js";
import { scheduleMethods, scheduleRpc } from "./tasks/rpc.js";

const gitWriteMethods = new Set([
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.branch.create",
  "git.branch.switch",
  "git.branch.delete",
  "git.fetch",
  "git.pull",
  "git.push",
  "git.continue",
  "git.abort",
]);

function knownRpcMethod(method: string): RpcMethod {
  if (!Object.hasOwn(rpcMutates, method))
    throw new AppError("unsupported", `Unsupported operation: ${method}`);
  return method as RpcMethod;
}

export class Agent {
  readonly metadata: MetadataStore;
  readonly cursorBudget = new CursorBudget();
  readonly directories = new Directories(this.cursorBudget);
  readonly repos: Repositories;
  readonly watches: WorkspaceWatches;
  readonly gitWrites: GitWriteQueue;
  readonly sessions: Sessions;
  readonly files: Files;
  readonly textFiles: TextFiles;
  readonly schedules: ScheduledTasks;
  private readonly temporaryFiles: TemporaryFiles;
  readonly fileOperations: FileOperations;
  private readonly local: LocalServer;
  private readonly channels: TerminalChannels;
  private readonly fileChannels: FileChannels;
  private readonly httpChannels: HttpChannels;
  readonly requests = new Map<string, AbortController>();
  readonly watched = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  socket?: WebSocket;
  connectionId?: string;
  private serverVersion?: string;
  private connectionError?: string;
  private reconnect?: NodeJS.Timeout;
  private stopped = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private delay = 1000;
  constructor(
    readonly config: AgentConfig,
    readonly identity: Identity,
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
    this.files = new Files(this.metadata, this.directories, this.temporaryFiles);
    this.metadata.onChange = (snapshot) => this.send({ type: "metadata.snapshot", snapshot });
    this.sessions = new Sessions(config, this.metadata);
    this.textFiles = new TextFiles(config, this.metadata, this.temporaryFiles);
    this.fileOperations = new FileOperations(this.metadata, this.temporaryFiles, (workspaceId) =>
      this.watches.changed(workspaceId, true),
    );
    this.channels = new TerminalChannels(
      this.sessions,
      config,
      identity,
      () => this.fileChannels.count + this.httpChannels.count,
    );
    this.fileChannels = new FileChannels(
      this.textFiles,
      new BinaryFiles(config, this.metadata, this.temporaryFiles),
      this.temporaryFiles,
      config,
      identity,
      () => this.channels.count + this.httpChannels.count,
      (workspaceId) => this.watches.changed(workspaceId, true),
    );
    this.httpChannels = new HttpChannels(
      config,
      identity,
      () => this.channels.count + this.fileChannels.count,
    );
    this.sessions.onChanged = (workspaceId) =>
      this.send({ type: "sessions.changed", workspaceId } satisfies AgentEvent);
    this.local = new LocalServer(config, (method, params, signal) => {
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
      if (!["sessions.list", "sessions.create", ...scheduleMethods].includes(method))
        throw new AppError("unsupported", "Unsupported local operation");
      return this.dispatch(method, params, signal);
    });
  }
  async start() {
    if (this.stopped) return;
    this.starting ??= this.initialize();
    try {
      await this.starting;
    } catch (error) {
      try {
        await this.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Agent startup and cleanup failed", {
          cause: closeError,
        });
      }
      throw error;
    }
  }
  private async initialize() {
    await privateDirectory(this.config.dataDir);
    if (this.stopped) return;
    await privateDirectory(this.config.runDir);
    if (this.stopped) return;
    await this.metadata.load();
    if (this.stopped) return;
    await this.temporaryFiles.load();
    if (this.stopped) return;
    await this.schedules.load();
    if (this.stopped) return;
    await this.local.start();
    this.connect();
  }
  send(message: unknown) {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "Control message exceeds the size limit");
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > limits.controlMessageBytes * 2) {
      this.socket.close(1013, "control_backpressure");
      return;
    }
    this.socket.send(text);
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL("/api/agent/control", this.identity.server);
    url.searchParams.set("protocolVersion", String(protocolVersion));
    url.searchParams.set("appVersion", appVersion);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = connectServerSocket(url, {
        headers: { authorization: `Bearer ${this.identity.deviceToken}` },
        maxPayload: limits.controlMessageBytes,
        handshakeTimeout: this.config.limits.channelPairTimeout,
      });
    } catch (error) {
      this.connectionError = asError(error).message;
      console.error("Control connection:", this.connectionError);
      this.scheduleReconnect();
      return;
    }
    let failure: string | undefined;
    this.socket = socket;
    let lastPong = Date.now();
    const ping = setInterval(() => {
      if (Date.now() - lastPong > limits.heartbeatTimeout) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, limits.heartbeatInterval);
    socket.on("pong", () => {
      lastPong = Date.now();
    });
    socket.on("open", () => this.send(this.metadata.hello()));
    socket.on("error", (error) => {
      this.connectionError = failure ??= error.message;
      console.error("Control connection:", error.message);
    });
    socket.on("unexpected-response", (_request, response) => {
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
        if (message.type === "welcome") {
          this.serverVersion = string(message.serverVersion);
          if (this.serverVersion !== appVersion)
            throw new AppError("version_mismatch", "Server returned a different release version");
          this.connectionId = string(message.connectionId);
          this.connectionError = undefined;
          this.delay = 1000;
          this.send({ type: "tasks.snapshot", ...this.schedules.snapshot() });
        } else if (message.type === "channel.open") {
          if (message.connectionId !== this.connectionId)
            throw new AppError("conflict", "Stale control connection");
          const channels =
            message.kind === "terminal.attach"
              ? this.channels
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
          this.channels.cancel(string(message.channelId));
          this.fileChannels.cancel(string(message.channelId));
          this.httpChannels.cancel(string(message.channelId));
        } else if (message.type === "rpc.request") {
          const id = string(message.id, "request id", 128);
          if (this.requests.has(id)) throw new AppError("conflict", "Duplicate request");
          const controller = new AbortController();
          const method = string(message.method);
          const params = record(message.params);
          this.requests.set(id, controller);
          const timeout = ["files.copy", "files.move", "files.delete"].includes(method)
            ? undefined
            : setTimeout(
                () => controller.abort(new AppError("timeout", "Operation timed out")),
                method === "files.search"
                  ? this.config.limits.searchTimeout
                  : gitWriteMethods.has(method)
                    ? this.config.limits.gitWriteTimeout
                    : this.config.limits.rpcTimeout,
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
        } else if (message.type === "rpc.cancel")
          this.requests
            .get(string(message.id))
            ?.abort(new AppError("cancelled", "Operation cancelled"));
        else if (message.type === "watch.set") {
          if (!Array.isArray(message.workspaceIds))
            throw new AppError("invalid_argument", "Invalid watches");
          const ids = new Set(message.workspaceIds.map((id) => string(id)));
          const workspaces = this.metadata.value.workspaces.filter((item) => ids.has(item.id));
          this.watched.clear();
          for (const workspace of workspaces) this.watched.add(workspace.id);
          void this.repos.retain(this.watched);
          this.watches.set(workspaces);
        }
      } catch (error) {
        console.error(asError(error).message);
        socket.close(1008, "invalid_control_message");
      }
    });
    socket.on("close", (code, reason) => {
      clearInterval(ping);
      this.connectionError =
        failure ??
        `Control connection closed (${code}${reason.length ? ": " + reason.toString() : ""})`;
      this.connectionId = undefined;
      for (const controller of this.requests.values())
        controller.abort(new AppError("cancelled", "Control connection interrupted"));
      this.watched.clear();
      void this.watches.close();
      void this.repos.close();
      this.channels.close();
      void this.fileChannels.close();
      this.httpChannels.close();
      void this.directories.close();
      if (this.stopped) return;
      if (code === 4001 || code === 4003) {
        console.error(`Remote connection stopped: ${reason.toString()}`);
        return;
      }
      this.scheduleReconnect();
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
        (["files.create", "files.rename"].includes(method) || gitWriteMethods.has(method)) &&
        typeof params.workspaceId === "string"
      )
        this.watches.changed(params.workspaceId, true);
    });
    this.tasks.add(operation);
    void operation.finally(() => this.tasks.delete(operation)).catch(() => {});
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
    switch (method) {
      case "tasks.list":
      case "tasks.get":
      case "tasks.preview":
      case "tasks.create":
      case "tasks.update":
      case "tasks.pause":
      case "tasks.resume":
      case "tasks.acknowledge":
      case "tasks.delete":
      case "tasks.run":
      case "runs.list":
      case "runs.get":
      case "runs.output":
      case "runs.stop":
        return scheduleRpc(this.schedules, method, params, signal);
      case "ports.list":
        return listeningPorts(signal) satisfies Promise<RpcResult<typeof method>>;
      case "git.remotes":
        return remotes(
          await this.repos.resolve(string(params.workspaceId), string(params.repoId), signal),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.fetch":
      case "git.pull":
      case "git.push":
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            syncRemote(
              repo,
              method.slice(4) as "fetch" | "pull" | "push",
              {
                remote: params.remote === undefined ? undefined : string(params.remote),
                expectedHead:
                  method === "git.fetch" ? undefined : expectedHead(params.expectedHead),
              },
              signal,
            ),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.continue":
      case "git.abort": {
        const expected = record(params.expectedOperation);
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            finishOperation(
              repo,
              string(expected.kind),
              string(expected.token),
              method === "git.continue" ? "continue" : "abort",
              signal,
            ),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      }
      case "git.commit":
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            commit(
              repo,
              string(params.message, "message", limits.controlMessageBytes),
              string(params.indexToken),
              signal,
            ),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.branch.create":
        if (typeof params.switch !== "boolean")
          throw new AppError("invalid_argument", "Choose whether to switch branches");
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            createBranch(
              repo,
              string(params.name),
              params.startOid === undefined ? undefined : string(params.startOid),
              params.switch === true,
              signal,
            ),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.branch.switch":
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            changeBranch(repo, string(params.name), string(params.refOid), "switch", signal),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.branch.delete":
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            changeBranch(repo, string(params.name), string(params.refOid), "delete", signal),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.stage":
      case "git.unstage":
      case "git.discard":
        return this.gitWrites.run(
          string(params.workspaceId),
          string(params.repoId),
          signal,
          (repo) =>
            method === "git.discard"
              ? discard(
                  repo,
                  gitPaths(params.paths),
                  discardScope(params.scope),
                  string(params.reviewToken),
                  signal,
                )
              : changeIndex(
                  repo,
                  gitPaths(params.paths),
                  method === "git.stage" ? "stage" : "unstage",
                  signal,
                ),
          progress,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.review":
        return reviewDiscard(
          await this.repos.resolve(string(params.workspaceId), string(params.repoId), signal),
          gitPaths(params.paths),
          discardScope(params.scope),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "repos.discover":
        return this.repos.discover(
          string(params.workspaceId),
          params.scanCursor === undefined ? undefined : string(params.scanCursor),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.status":
        return status(
          await this.repos.resolve(string(params.workspaceId), string(params.repoId), signal),
          params.offset === undefined
            ? 0
            : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
          params.expectedListToken === undefined ? undefined : string(params.expectedListToken),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.diff": {
        const repo = await this.repos.resolve(
          string(params.workspaceId),
          string(params.repoId),
          signal,
        );
        if (params.side === "commit")
          return commitDiff(
            repo,
            string(params.commitOid),
            params.parentOid === undefined ? undefined : string(params.parentOid),
            string(params.path),
            signal,
          ) satisfies Promise<RpcResult<typeof method>>;
        if (params.side !== "worktree" && params.side !== "staged")
          throw new AppError("invalid_argument", "Invalid diff side");
        return workingDiff(repo, string(params.path), params.side, signal) satisfies Promise<
          RpcResult<typeof method>
        >;
      }
      case "git.history":
        return history(
          await this.repos.resolve(string(params.workspaceId), string(params.repoId), signal),
          params.anchorOid === undefined ? undefined : string(params.anchorOid),
          params.offset === undefined
            ? 0
            : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.commitFiles":
        return commitFiles(
          await this.repos.resolve(string(params.workspaceId), string(params.repoId), signal),
          string(params.commitOid),
          params.parentOid === undefined ? undefined : string(params.parentOid),
          params.offset === undefined
            ? 0
            : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "git.branches":
        return branches(
          await this.repos.resolve(string(params.workspaceId), string(params.repoId), signal),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
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
      case "files.cleanup": {
        const state = this.temporaryFiles.status();
        state.pending ||= this.fileOperations.cleanupPending || this.fileChannels.cleaning;
        return state satisfies RpcResult<typeof method>;
      }
      case "files.list": {
        const result = await this.files.list(
          string(params.workspaceId),
          string(params.path),
          params.cursor === undefined ? undefined : string(params.cursor),
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
          params.cursor === undefined ? undefined : string(params.cursor),
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
          params.name === undefined ? undefined : string(params.name, "name", 256),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "workspaces.rename": {
        const id = string(params.workspaceId);
        const name = string(params.name, "name", 256);
        return this.metadata.update((metadata) => {
          const workspace = metadata.workspaces.find((w) => w.id === id);
          if (!workspace) throw new AppError("not_found", "Workspace does not exist");
          workspace.name = name;
          return workspace;
        }, signal) satisfies Promise<RpcResult<typeof method>>;
      }
      case "workspaces.remove": {
        const id = string(params.workspaceId);
        this.metadata.workspace(id);
        return this.metadata.update((metadata) => {
          if (this.sessions.list(id).sessions.length)
            throw new AppError("busy", "End the terminal sessions in the workspace first");
          metadata.workspaces = metadata.workspaces.filter((w) => w.id !== id);
          return { removed: true };
        }, signal) satisfies Promise<RpcResult<typeof method>>;
      }
      case "sessions.list": {
        const workspaceId =
          params.workspaceId === undefined ? undefined : string(params.workspaceId);
        if (workspaceId) this.metadata.workspace(workspaceId);
        return this.sessions.list(workspaceId) satisfies RpcResult<typeof method>;
      }
      case "sessions.create":
        return this.sessions.create(
          string(params.workspaceId),
          params.name === undefined ? undefined : string(params.name, "name", 256),
          params.shortcutId === undefined ? undefined : string(params.shortcutId),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      case "sessions.rename":
        return this.sessions.rename(
          string(params.workspaceId),
          string(params.sessionId),
          string(params.name, "name", 256),
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
      case "settings.update": {
        const historyLines = integer(params.historyLines, "historyLines", 0, 50_000);
        return this.metadata.update((metadata) => {
          metadata.settings.historyLines = historyLines;
          return metadata.settings;
        }, signal) satisfies Promise<RpcResult<typeof method>>;
      }
      case "shortcuts.put": {
        const id = params.id === undefined ? randomUUID() : string(params.id);
        const name = string(params.name, "name", 256);
        const command = string(params.command, "command", 65536);
        const icon = checkShortcutIcon(params.icon);
        return this.metadata.update((metadata) => {
          const previous = metadata.shortcuts.find((item) => item.id === id);
          if (params.id !== undefined && !previous)
            throw new AppError("not_found", "Shortcut does not exist");
          const shortcut = { id, name, command, icon };
          if (previous) Object.assign(previous, shortcut);
          else metadata.shortcuts.push(shortcut);
          return shortcut;
        }, signal) satisfies Promise<RpcResult<typeof method>>;
      }
      case "shortcuts.remove": {
        const id = string(params.id);
        return this.metadata.update((metadata) => {
          metadata.shortcuts = metadata.shortcuts.filter((item) => item.id !== id);
          return { removed: true };
        }, signal) satisfies Promise<RpcResult<typeof method>>;
      }
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
    this.temporaryFiles.beginClose();
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
      finish(() => this.channels.close()),
      finish(() => this.httpChannels.close()),
      finish(() => this.local.close()),
      finish(() => this.schedules.close()),
      finish(() => this.fileChannels.close()),
      finish(() => this.fileOperations.close()),
      Promise.allSettled([...this.tasks]),
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
