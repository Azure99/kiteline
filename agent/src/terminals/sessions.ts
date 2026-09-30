import { randomBytes } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { constants, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError, OperationError, limits, type Session } from "@kiteline/shared/protocol";
import type { CreateTerminal, RecorderMessage, TerminalIdentity } from "@kiteline/shared/ipc";
import { exitCodeFormat, msysPath, tmux, tmuxServerMissing } from "@kiteline/shared/terminal/node";
import { startTerminalServer } from "@kiteline/shared/terminal/windows";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { Recorder, type Creation } from "./recorder.js";

export const sessionIdBytes = 8;

interface Managed {
  session: Session;
  identity: Partial<TerminalIdentity> & Pick<TerminalIdentity, "socket">;
  creation?: Promise<Session>;
  creationMayArrive?: boolean;
  createRequest?: Creation;
  server?: Awaited<ReturnType<typeof startTerminalServer>>;
  cleanup?: Promise<void>;
  recovery?: Promise<void>;
  ending?: boolean;
}
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
  onChanged?: (workspaceId: string) => void;
  onFrame?: (message: RecorderMessage) => void;
  constructor(
    private config: AgentConfig,
    private metadata: MetadataStore,
  ) {
    this.recorder = new Recorder(config.limits);
    this.recorder.onMessage = (message) => this.message(message);
    this.recorder.onExit = (reason) => {
      for (const item of this.records.values()) {
        if (process.platform !== "win32") item.creationMayArrive = false;
        this.unavailable(item, reason);
        this.onFrame?.({
          type: "fault",
          sessionId: item.session.id,
          error: { code: "recording_unavailable", message: reason },
        });
      }
    };
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
  get(id: string, workspaceId?: string) {
    const item = this.records.get(id);
    if (!item || (workspaceId && item.session.workspaceId !== workspaceId))
      throw new AppError("not_found", "Terminal session does not exist");
    return item;
  }
  private track<T>(promise: Promise<T>) {
    this.jobs.add(promise);
    void promise.finally(() => this.jobs.delete(promise)).catch(() => {});
    return promise;
  }
  async create(
    workspaceId: string,
    name: string | undefined,
    shortcutId: string | undefined,
    signal: AbortSignal,
  ) {
    if (this.closing) throw new AppError("cancelled", "Agent is stopping");
    await access(this.config.shell, constants.X_OK);
    const socket = join(this.config.runDir, "0".repeat(sessionIdBytes * 2), "tmux.sock");
    if (Buffer.byteLength(process.platform === "win32" ? msysPath(socket) : socket) > 103)
      throw new AppError(
        "invalid_argument",
        "Runtime directory path is too long; use a shorter KITELINE_AGENT_RUN_DIR",
      );
    const { item, workspace, shortcut } = await this.metadata.withCurrent((metadata) => {
      signal.throwIfAborted();
      if (this.closing) throw new AppError("cancelled", "Agent is stopping");
      if (this.records.size >= this.config.limits.terminalSessionsPerDevice)
        throw new AppError("busy", "Device terminal session limit reached");
      const workspace = this.metadata.workspace(workspaceId);
      const shortcut = shortcutId
        ? metadata.shortcuts.find((item) => item.id === shortcutId)
        : undefined;
      if (shortcutId && !shortcut) throw new AppError("not_found", "Shortcut does not exist");
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
            name: name ?? shortcut?.name ?? "Shell",
            createdAt: new Date().toISOString(),
            historyLines: metadata.settings.historyLines,
            state: "starting",
            webStatus: "unavailable",
            historyGap: false,
          },
          identity: { socket },
        };
        this.records.set(id, item);
        return { item, workspace, shortcut };
      }
      throw new AppError("busy", "Could not allocate an unused terminal session ID");
    });
    const { id } = item.session;
    this.onChanged?.(workspaceId);
    const operation = this.track(
      (async () => {
        try {
          const options: CreateTerminal = {
            sessionId: id,
            socket: item.identity.socket,
            workspacePath: workspace.path,
            shell: this.config.shell,
            command: shortcut?.command,
            cols: limits.terminalInitialCols,
            rows: limits.terminalInitialRows,
            historyLines: item.session.historyLines,
          };
          if (process.platform === "win32")
            item.server = await startTerminalServer(options, this.config.limits.channelPairTimeout);
          if (this.closing) throw new AppError("cancelled", "Agent is stopping");
          item.creationMayArrive = true;
          let identity: TerminalIdentity;
          if (process.platform === "win32") {
            item.createRequest = this.recorder.create(options);
            identity = await item.createRequest.result;
          } else
            identity = await this.recorder.request<TerminalIdentity>({
              type: "create",
              ...options,
            });
          item.creationMayArrive = false;
          if (!this.records.has(id) || item.cleanup)
            throw new OperationError("io_error", "Terminal has ended", "unknown", {
              sessionId: id,
            });
          item.identity = identity;
          item.session.state = "running";
          item.session.webStatus = "available";
          this.onChanged?.(workspaceId);
          return { ...item.session };
        } catch (error) {
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
          const state = await this.inspect(item).catch(() => undefined);
          if (state?.alive) {
            item.session.state = "running";
            this.unavailable(item, error instanceof Error ? error.message : String(error));
            return { ...item.session };
          }
          if (state && !state.alive && !item.creationMayArrive) {
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
      })(),
    );
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
          { sessionId: id },
        );
      throw error;
    }
  }
  rename(workspaceId: string, id: string, name: string) {
    const item = this.get(id, workspaceId);
    item.session.name = name;
    this.onChanged?.(workspaceId);
    return item.session;
  }
  async end(workspaceId: string | undefined, id: string) {
    const item = this.get(id, workspaceId);
    item.ending = true;
    try {
      await item.creation?.catch(() => {});
      await item.recovery;
      if (this.recorder.available) {
        try {
          await this.recorder.request({ type: "end", sessionId: id });
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
  recover(workspaceId: string, id: string) {
    const item = this.get(id, workspaceId);
    if (this.closing || item.ending) throw new AppError("cancelled", "Terminal is ending");
    if (item.creation || item.session.state !== "running")
      throw new AppError("busy", "Terminal is still being created");
    if (item.session.webStatus === "available" || item.recovery) return { ...item.session };
    item.session.webStatus = "recovering";
    delete item.session.webReason;
    this.onChanged?.(workspaceId);
    item.recovery = this.track(
      (async () => {
        try {
          const state = await this.inspect(item);
          if (!state.alive) {
            await this.remove(item);
            return;
          }
          await this.recorder.request({
            type: "recover",
            sessionId: id,
            ...(item.identity as TerminalIdentity),
            cols: state.cols!,
            rows: state.rows!,
            historyLines: item.session.historyLines,
          });
          if (this.records.get(id) === item && !item.cleanup && !item.ending) {
            item.session.webStatus = "available";
            delete item.session.webReason;
            this.onChanged?.(workspaceId);
          }
        } catch (error) {
          if (this.records.get(id) === item && !item.cleanup)
            this.unavailable(item, error instanceof Error ? error.message : String(error));
        } finally {
          item.recovery = undefined;
        }
      })(),
    );
    return { ...item.session };
  }
  async redraw(workspaceId: string, id: string) {
    const item = this.get(id, workspaceId);
    if (item.session.webStatus !== "available" || item.ending)
      throw new AppError("recording_unavailable", "Recover terminal recording first");
    await this.recorder.request({ type: "redraw", sessionId: id });
    return { ...item.session };
  }
  private unavailable(item: Managed, reason: string) {
    item.session.webStatus = "unavailable";
    item.session.historyGap = true;
    item.session.webReason = reason;
    this.onChanged?.(item.session.workspaceId);
  }
  private message(message: RecorderMessage) {
    if (message.type === "fault") {
      const item = this.records.get(message.sessionId);
      if (item) this.unavailable(item, message.error.message);
    } else if (message.type === "ended") {
      const item = this.records.get(message.sessionId);
      if (item) void this.track(this.remove(item)).catch((error: unknown) => console.error(error));
    }
    this.onFrame?.(message);
  }
  private async inspect(item: Managed) {
    try {
      const output = await tmux(
        item.identity.socket,
        [
          "list-panes",
          "-a",
          "-F",
          `#{pane_id} #{window_id} #{pane_dead} ${exitCodeFormat}|#{pane_width} #{pane_height}`,
        ],
        undefined,
        AbortSignal.timeout(this.config.limits.rpcTimeout),
      );
      if (process.platform === "win32" && !output.trim())
        return { alive: false, exitCode: null, cols: undefined, rows: undefined };
      const result = /^(%\d+) (@\d+) ([01]) (\d*)\|(\d+) (\d+)\s*$/.exec(output);
      if (!result) throw new Error("Cannot verify the managed terminal identity");
      item.creationMayArrive = false;
      item.identity.paneId = result[1];
      item.identity.windowId = result[2];
      return {
        alive: result[3] === "0",
        exitCode: result[4] ? Number(result[4]) : null,
        cols: Number(result[5]),
        rows: Number(result[6]),
      };
    } catch (error) {
      if (tmuxServerMissing(error))
        return { alive: false, exitCode: null, cols: undefined, rows: undefined };
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
        const state = await this.inspect(item).catch(() => undefined);
        if (state?.alive && item.session.state === "starting") {
          item.session.state = "running";
          this.onChanged?.(item.session.workspaceId);
        } else if (state && !state.alive && !item.creationMayArrive) await this.remove(item);
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
          item.identity.socket,
          ["kill-server"],
          undefined,
          AbortSignal.timeout(this.config.limits.rpcTimeout),
        );
      } catch (error) {
        if (!item.server && (await this.inspect(item)).alive) throw error;
      } finally {
        if (item.server) {
          await item.server.job.stop();
          await item.server.drained;
        }
      }
      this.records.delete(item.session.id);
      this.onChanged?.(item.session.workspaceId);
      await rm(dirname(item.identity.socket), { recursive: true, force: true });
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
