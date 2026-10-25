import { agentLimits } from "../limits.js";
import { randomBytes } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { constants, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AppError,
  OperationError,
  asError,
  defaultTerminalOperationTimeoutMs,
  defaultTerminalWaitTimeoutMs,
  limits,
  parseInputPosition,
  parseScreenWait,
  parseSessionInput,
  parseSnapshotOptions,
  parseTerminalCols,
  parseTerminalRows,
  parseTerminalTimeoutMs,
  string,
  type Session,
  type AgentEvent,
  type RpcResult,
} from "@kiteline/shared/protocol";
import type {
  CreateTerminal,
  RecorderMessage,
  TerminalIdentity,
} from "@kiteline/shared/protocol/ipc";
import { msysPath, tmux, tmuxServerMissing } from "@kiteline/shared/terminal/node";
import { startTerminalServer } from "@kiteline/shared/terminal/windows";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { Recorder, type Creation } from "./recorder.js";

const sessionIdBytes = 8;

export function checkRunDir(runDir: string) {
  const socket = join(runDir, "0".repeat(sessionIdBytes * 2), "tmux.sock");
  if (Buffer.byteLength(process.platform === "win32" ? msysPath(socket) : socket) > 103)
    throw new AppError(
      "invalid_argument",
      "KITELINE_AGENT_RUN_DIR is too long; configure a shorter user-writable directory",
    );
}

interface Managed {
  session: Session;
  socket: string;
  creation?: Promise<Session>;
  // A recorder timeout can leave creation in flight; a missing tmux server is not yet proof of failure.
  creationMayArrive?: boolean;
  createRequest?: Creation;
  server?: Awaited<ReturnType<typeof startTerminalServer>>;
  cleanup?: Promise<void>;
  recovery?: Promise<void>;
  ending?: boolean;
}
interface SessionTarget {
  workspaceId: string;
  sessionId: string;
}
interface CreateSession {
  workspaceId: string;
  name?: string;
  shortcutId?: string;
}
interface SessionEvents {
  changed(workspaceId: string): void;
  frame(message: RecorderMessage): void;
  notice(message: Extract<AgentEvent, { type: "terminal.notice" }>): void;
}
type TerminalFacts =
  | { kind: "missing" }
  | {
      kind: "pane";
      identity: TerminalIdentity;
      alive: boolean;
      cols: number;
      rows: number;
    };

function waitFor<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class Sessions {
  readonly recorder: Recorder;
  private records = new Map<string, Managed>();
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private checking = false;
  private lifeTimer: NodeJS.Timeout;
  constructor(
    private config: AgentConfig,
    private metadata: MetadataStore,
    private readonly events: SessionEvents,
  ) {
    this.recorder = new Recorder(
      { terminalInputBytes: config.limits.terminalInputBytes },
      {
        message: (message) => this.message(message),
        exit: (reason) => {
          for (const item of this.records.values()) {
            if (process.platform !== "win32") item.creationMayArrive = false;
            this.message({
              type: "fault",
              sessionId: item.session.id,
              error: { code: "recording_unavailable", message: reason },
            });
          }
        },
      },
    );
    this.lifeTimer = setInterval(() => {
      void this.track(this.checkUnavailable()).catch(console.error);
    }, 2000);
    this.lifeTimer.unref();
  }
  list(workspaceId?: string) {
    return {
      sessions: [...this.records.values()]
        .map((item) => item.session)
        .filter((session) => !workspaceId || session.workspaceId === workspaceId),
    };
  }
  private get({ sessionId, workspaceId }: { sessionId: string; workspaceId?: string }) {
    const item = this.records.get(sessionId);
    if (!item || (workspaceId && item.session.workspaceId !== workspaceId))
      throw new AppError("not_found", "Terminal session does not exist");
    return item;
  }
  private recording(target: SessionTarget) {
    const item = this.get(target);
    if (item.session.webStatus !== "available" || item.ending)
      throw new AppError("recording_unavailable", "Recover terminal recording first");
    return item.session;
  }
  private recordingForRpc(params: Record<string, unknown>) {
    return this.recording({
      sessionId: string(params.sessionId),
      workspaceId: string(params.workspaceId),
    });
  }
  snapshot(params: Record<string, unknown>): Promise<RpcResult<"sessions.snapshot">> {
    const { id: sessionId, historyGap } = this.recordingForRpc(params);
    const options = parseSnapshotOptions(params);
    return this.recorder.request({ type: "snapshot", sessionId, options, historyGap });
  }
  send(params: Record<string, unknown>): Promise<RpcResult<"sessions.send">> {
    const { id: sessionId } = this.recordingForRpc(params);
    const timeoutMs = parseTerminalTimeoutMs(params.timeoutMs ?? defaultTerminalOperationTimeoutMs);
    const input = parseSessionInput(params.input);
    const ifInput = params.ifInput === undefined ? undefined : parseInputPosition(params.ifInput);
    const deadline = Date.now() + timeoutMs;
    return this.recorder.request({ type: "session.send", sessionId, input, ifInput, deadline });
  }
  wait(params: Record<string, unknown>): Promise<RpcResult<"sessions.wait">> {
    const { id: sessionId, historyGap } = this.recordingForRpc(params);
    const timeoutMs = parseTerminalTimeoutMs(params.timeoutMs ?? defaultTerminalWaitTimeoutMs);
    const options = parseScreenWait(params);
    const deadline = Date.now() + timeoutMs;
    return this.recorder.request({ type: "wait", sessionId, options, historyGap, deadline });
  }
  resize(params: Record<string, unknown>): Promise<RpcResult<"sessions.resize">> {
    const { id: sessionId } = this.recordingForRpc(params);
    const timeoutMs = parseTerminalTimeoutMs(params.timeoutMs ?? defaultTerminalOperationTimeoutMs);
    const cols = parseTerminalCols(params.cols);
    const rows = parseTerminalRows(params.rows);
    const deadline = Date.now() + timeoutMs;
    return this.recorder.request({ type: "session.resize", sessionId, cols, rows, deadline });
  }
  channelOpenStatus(target: SessionTarget) {
    const item = this.get(target);
    if (item.session.state !== "running")
      throw new AppError("busy", "Terminal is still being created");
    return { webStatus: item.session.webStatus };
  }
  channelStartTarget(id: string) {
    const item = this.get({ sessionId: id });
    return {
      socket: item.socket,
      webStatus: item.session.webStatus,
      historyGap: item.session.historyGap,
    };
  }
  private track<T>(promise: Promise<T>) {
    this.jobs.add(promise);
    void promise.finally(() => this.jobs.delete(promise)).catch(() => {});
    return promise;
  }
  async create(options: CreateSession, signal: AbortSignal) {
    if (this.closing) throw new AppError("cancelled", "Agent is stopping");
    await access(this.config.shell, constants.X_OK);
    const { item, terminal } = await this.registerCreation(options, signal);
    this.events.changed(item.session.workspaceId);
    const operation = this.track(this.startCreation(item, terminal));
    item.creation = operation;
    void operation
      .finally(() => {
        item.creation = undefined;
      })
      .catch(() => {});
    try {
      return await waitFor(operation, signal);
    } catch (error) {
      if (signal.aborted)
        throw new OperationError(
          "cancelled",
          "Terminal creation confirmation was interrupted",
          "unknown",
          { sessionId: item.session.id },
        );
      throw error;
    }
  }
  private registerCreation({ workspaceId, name, shortcutId }: CreateSession, signal: AbortSignal) {
    return this.metadata.withSessionRegistration((metadata) => {
      signal.throwIfAborted();
      if (this.closing) throw new AppError("cancelled", "Agent is stopping");
      if (this.records.size >= this.config.limits.terminalSessionsPerDevice)
        throw new AppError("busy", "Device terminal session limit reached");
      const workspace = this.metadata.workspace(workspaceId);
      const shortcut = shortcutId
        ? metadata.shortcuts.find((item) => item.id === shortcutId)
        : undefined;
      if (shortcutId && !shortcut) throw new AppError("not_found", "Shortcut does not exist");
      let sessionName = name ?? shortcut?.name;
      if (sessionName === undefined) {
        const occupied = new Set(
          [...this.records.values()]
            .filter((item) => item.session.workspaceId === workspaceId)
            .map((item) => item.session.name),
        );
        sessionName = "Shell";
        for (let number = 2; occupied.has(sessionName); number++) sessionName = `Shell ${number}`;
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const id = randomBytes(sessionIdBytes).toString("hex");
        if (this.records.has(id)) continue;
        const socket = join(this.config.runDir, id, "tmux.sock");
        try {
          // Directory ownership and registration share the synchronous workspace boundary.
          mkdirSync(dirname(socket), { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        const item: Managed = {
          session: {
            id,
            workspaceId,
            name: sessionName,
            createdAt: new Date().toISOString(),
            historyLines: metadata.settings.historyLines,
            state: "starting",
            webStatus: "unavailable",
            historyGap: false,
          },
          socket,
        };
        this.records.set(id, item);
        return {
          item,
          terminal: {
            sessionId: id,
            socket,
            workspacePath: workspace.path,
            shell: this.config.shell,
            command: shortcut?.command,
            cols: agentLimits.terminalInitialCols,
            rows: agentLimits.terminalInitialRows,
            historyLines: item.session.historyLines,
          } satisfies CreateTerminal,
        };
      }
      throw new AppError("busy", "Could not allocate an unused terminal session ID");
    });
  }
  private async startCreation(item: Managed, options: CreateTerminal): Promise<Session> {
    const { id, workspaceId } = item.session;
    try {
      if (process.platform === "win32")
        item.server = await startTerminalServer(options, limits.interactionTimeout);
      if (this.closing) throw new AppError("cancelled", "Agent is stopping");
      item.creationMayArrive = true;
      if (process.platform === "win32") {
        item.createRequest = this.recorder.create(options);
        await item.createRequest.result;
      } else
        await this.recorder.request<TerminalIdentity>({
          type: "create",
          ...options,
        });
      item.creationMayArrive = false;
      if (!this.records.has(id) || item.cleanup)
        throw new OperationError("io_error", "Terminal has ended", "unknown", {
          sessionId: id,
        });
      item.session.state = "running";
      item.session.webStatus = "available";
      this.events.changed(workspaceId);
      return { ...item.session };
    } catch (error) {
      return this.settleCreationFailure(item, error);
    }
  }
  private async settleCreationFailure(item: Managed, error: unknown): Promise<Session> {
    const { id } = item.session;
    if (process.platform === "win32") {
      await item.createRequest?.cancel();
      item.creationMayArrive = false;
    } else if (!(error instanceof OperationError)) item.creationMayArrive = false;
    if (!this.records.has(id))
      throw new OperationError(
        "io_error",
        "Terminal was created and then ended; check the session list",
        "unknown",
        {
          sessionId: id,
        },
      );
    const facts = await this.observePane(item).catch(() => undefined);
    if (facts?.kind === "pane" && facts.alive) {
      item.session.state = "running";
      this.unavailable(item, asError(error).message);
      return { ...item.session };
    }
    if (facts && !item.creationMayArrive) {
      await this.remove(item);
      throw error;
    }
    throw new OperationError(
      "io_error",
      "Could not confirm terminal creation; check the session list",
      "unknown",
      {
        sessionId: id,
      },
    );
  }
  rename(target: SessionTarget, name: string) {
    const item = this.get(target);
    item.session.name = name;
    this.events.changed(item.session.workspaceId);
    return item.session;
  }
  async end(target: { sessionId: string; workspaceId?: string }) {
    const item = this.get(target);
    item.ending = true;
    try {
      await item.creation?.catch(() => {});
      await item.recovery;
      if (this.recorder.available) {
        try {
          await this.recorder.request({ type: "end", sessionId: item.session.id });
        } catch (error) {
          if (
            process.platform !== "win32" &&
            (!(error instanceof AppError) || error.code !== "recording_unavailable")
          )
            throw error;
        }
      }
      await this.remove(item);
      return { ended: true };
    } finally {
      item.ending = false;
    }
  }
  recover(target: SessionTarget) {
    const item = this.get(target);
    const { id, workspaceId } = item.session;
    if (this.closing || item.ending) throw new AppError("cancelled", "Terminal is ending");
    if (item.creation || item.session.state !== "running")
      throw new AppError("busy", "Terminal is still being created");
    if (item.session.webStatus === "available" || item.recovery) return { ...item.session };
    item.session.webStatus = "recovering";
    delete item.session.webReason;
    this.events.changed(workspaceId);
    item.recovery = this.track(
      (async () => {
        try {
          const facts = await this.observePane(item);
          if (facts.kind === "missing" || !facts.alive) {
            await this.remove(item);
            return;
          }
          await this.recorder.request({
            type: "recover",
            sessionId: id,
            ...facts.identity,
            cols: facts.cols,
            rows: facts.rows,
            historyLines: item.session.historyLines,
          });
          if (this.records.get(id) === item && !item.cleanup && !item.ending) {
            item.session.webStatus = "available";
            delete item.session.webReason;
            this.events.changed(workspaceId);
          }
        } catch (error) {
          if (this.records.get(id) === item && !item.cleanup)
            this.unavailable(item, asError(error).message);
        } finally {
          item.recovery = undefined;
        }
      })(),
    );
    return { ...item.session };
  }
  async redraw(target: SessionTarget) {
    const session = this.recording(target);
    await this.recorder.request({ type: "redraw", sessionId: session.id });
    return { ...session };
  }
  private unavailable(item: Managed, reason: string) {
    item.session.webStatus = "unavailable";
    item.session.historyGap = true;
    item.session.webReason = reason;
    this.events.changed(item.session.workspaceId);
  }
  private message(message: RecorderMessage) {
    if (message.type === "notice") {
      const item = this.records.get(message.sessionId);
      if (item)
        this.events.notice({
          type: "terminal.notice",
          workspaceId: item.session.workspaceId,
          sessionId: item.session.id,
          name: item.session.name,
          notice: message.notice,
        });
      return;
    }
    if (message.type === "fault") {
      const item = this.records.get(message.sessionId);
      if (item) this.unavailable(item, message.error.message);
    } else if (message.type === "ended") {
      const item = this.records.get(message.sessionId);
      if (item) void this.track(this.remove(item)).catch((error: unknown) => console.error(error));
    }
    this.events.frame(message);
  }
  private async observePane(item: Managed) {
    const facts = await this.inspect(item.socket);
    if (facts.kind === "pane") item.creationMayArrive = false;
    return facts;
  }
  private async inspect(socket: string): Promise<TerminalFacts> {
    try {
      const output = await tmux(
        socket,
        [
          "list-panes",
          "-a",
          "-F",
          "#{pane_id} #{window_id} #{pane_dead} #{pane_width} #{pane_height}",
        ],
        undefined,
        AbortSignal.timeout(this.config.limits.rpcTimeout),
      );
      if (process.platform === "win32" && !output.trim()) return { kind: "missing" };
      const result = /^(%\d+) (@\d+) ([01]) (\d+) (\d+)\s*$/.exec(output);
      if (!result) throw new Error("Cannot verify the managed terminal identity");
      return {
        kind: "pane",
        identity: { socket, paneId: result[1]!, windowId: result[2]! },
        alive: result[3] === "0",
        cols: Number(result[4]),
        rows: Number(result[5]),
      };
    } catch (error) {
      if (tmuxServerMissing(error)) return { kind: "missing" };
      throw error;
    }
  }
  private async checkUnavailable() {
    if (this.closing || this.checking) return;
    this.checking = true;
    try {
      for (const item of this.records.values()) {
        if (
          item.session.webStatus !== "unavailable" ||
          item.creation ||
          item.cleanup ||
          item.recovery ||
          item.ending
        )
          continue;
        const facts = await this.observePane(item).catch(() => undefined);
        if (facts?.kind === "pane" && facts.alive && item.session.state === "starting") {
          item.session.state = "running";
          this.events.changed(item.session.workspaceId);
        } else if (facts && (facts.kind === "missing" || !facts.alive) && !item.creationMayArrive)
          await this.remove(item);
      }
    } finally {
      this.checking = false;
    }
  }
  private remove(item: Managed): Promise<void> {
    if (item.cleanup) return item.cleanup;
    if (this.records.get(item.session.id) !== item) return Promise.resolve();
    item.cleanup = (async () => {
      try {
        await tmux(
          item.socket,
          ["kill-server"],
          undefined,
          AbortSignal.timeout(this.config.limits.rpcTimeout),
        );
      } catch (error) {
        if (!item.server) {
          const facts = await this.observePane(item);
          if (facts.kind === "pane" && facts.alive) throw error;
        }
      } finally {
        if (item.server) {
          await item.server.job.stop();
          await item.server.drained;
        }
      }
      this.records.delete(item.session.id);
      this.events.changed(item.session.workspaceId);
      await rm(dirname(item.socket), { recursive: true, force: true });
    })().finally(() => {
      item.cleanup = undefined;
    });
    return item.cleanup;
  }
  async close() {
    this.closing = true;
    clearInterval(this.lifeTimer);
    if (process.platform === "win32")
      await Promise.all([...this.records.values()].map((item) => item.createRequest?.cancel()));
    await Promise.allSettled([...this.jobs]);
    await this.recorder.close();
    const results = await Promise.allSettled(
      [...this.records.values()].map((item) => this.remove(item)),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, "Some terminals could not be ended");
  }
}
