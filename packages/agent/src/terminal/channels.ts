import { WebSocket } from "ws";
import {
  AppError,
  asError,
  integer,
  limits,
  parseTerminalCols,
  parseTerminalRows,
  record,
  string,
} from "@kiteline/shared/protocol";
import type {
  BrowserTerminalInput,
  RecorderMessage,
  TtyFrame,
} from "@kiteline/shared/protocol/ipc";
import { heartbeat, sendFrame } from "@kiteline/shared/protocol/ws";
import type { AgentConfig, Identity } from "../config.js";
import type { Sessions } from "./sessions.js";
import { connectChannel } from "../network.js";
import { TtyBridge } from "./tty.js";
import type { Recorder } from "./recorder.js";

interface Channel {
  id: string;
  sessionId: string;
  socket: WebSocket;
  started: boolean;
  backend?: WebBackend | TtyBackend;
}

type StartTarget = ReturnType<Sessions["channelStartTarget"]>;
type TerminalInput = Buffer | BrowserTerminalInput;
interface ChannelActions {
  fail(error: unknown): void;
  cancel(): void;
}

class WebBackend {
  constructor(
    private channel: Channel,
    private recorder: Recorder,
    private history: "retained" | "screen",
    private actions: ChannelActions,
  ) {}

  start(target: StartTarget) {
    if (target.webStatus !== "available")
      throw new AppError("recording_unavailable", "Terminal recording is unavailable");
    const { id, sessionId } = this.channel;
    void this.recorder
      .request({
        type: "attach",
        sessionId,
        attachmentId: id,
        history: this.history,
        historyGap: target.historyGap,
      })
      .catch(this.actions.fail);
  }

  input(input: TerminalInput) {
    this.recorder.send({
      sessionId: this.channel.sessionId,
      attachmentId: this.channel.id,
      ...(Buffer.isBuffer(input) ? { type: "input", dataBase64: input.toString("base64") } : input),
    });
  }

  inputFailed(error: unknown) {
    try {
      sendFrame(
        this.channel.socket,
        JSON.stringify({ type: "input.error", ...asError(error), outcome: "failed" }),
      );
    } catch {
      this.actions.cancel();
    }
  }

  frame(message: Extract<RecorderMessage, { type: "bytes" | "frame" }>) {
    try {
      if (message.type === "bytes") {
        sendFrame(this.channel.socket, Buffer.from(message.dataBase64, "base64"));
      } else {
        sendFrame(this.channel.socket, JSON.stringify(message.frame));
        if (message.frame.type === "ended" || message.frame.type === "error") this.actions.cancel();
      }
    } catch (error) {
      this.actions.fail(error);
    }
  }

  close() {
    try {
      this.recorder.detach(this.channel.sessionId, this.channel.id);
    } catch {
      /* Recorder failure already closes its displays. */
    }
  }
}

class TtyBackend {
  private bridge?: Promise<TtyBridge>;

  constructor(
    private channel: Channel,
    private options: { cols: number; rows: number; term: string },
    private actions: ChannelActions & { isCurrent(): boolean },
  ) {}

  start(target: StartTarget) {
    const { socket } = this.channel;
    socket.pause();
    this.bridge = TtyBridge.start(
      target.socket,
      this.options,
      (data) => sendFrame(socket, data),
      () => {
        try {
          sendFrame(socket, JSON.stringify({ type: "ended", exitCode: 0 } satisfies TtyFrame));
        } catch (error) {
          this.actions.fail(error);
        } finally {
          this.actions.cancel();
        }
      },
      this.actions.fail,
    );
    void this.bridge.then(
      () => socket.resume(),
      (error: unknown) => {
        socket.resume();
        this.actions.fail(error);
      },
    );
  }

  input(input: TerminalInput) {
    void this.bridge!.then((bridge) => {
      if (!this.actions.isCurrent()) return;
      try {
        if (Buffer.isBuffer(input)) bridge.input(input);
        else if (input.type === "resize") bridge.resize(input.cols, input.rows);
        else if (input.type === "consumed") bridge.acknowledge(input.bytes);
        else throw new AppError("invalid_argument", "Invalid TTY input");
      } catch (error) {
        this.actions.fail(error);
      }
    }, this.actions.fail);
  }

  close() {
    return this.bridge?.then(
      (bridge) => bridge.stop(),
      () => {}, // spawnJob already cleans up a failed startup.
    );
  }
}

export class TerminalChannels {
  private entries = new Map<string, Channel>();
  private closing = new Set<Promise<void>>();
  constructor(
    private sessions: Sessions,
    private config: AgentConfig,
    private identity: Identity,
  ) {}
  open(id: string, connectionId: string, params: Record<string, unknown>) {
    if (this.entries.has(id)) throw new AppError("conflict", "Channel already exists");
    const socket = connectChannel(this.identity, id, connectionId, {
      maxPayload: limits.controlMessageBytes,
    });
    const channel: Channel = {
      id,
      sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
      socket,
      started: false,
    };
    this.entries.set(id, channel);
    socket.on("upgrade", (response) =>
      response.socket.setKeepAlive(true, limits.tcpKeepAliveDelayMs),
    );
    socket.on("open", () => {
      heartbeat(socket);
      try {
        const status = this.sessions.channelOpenStatus({
          sessionId: string(params.sessionId),
          workspaceId: string(params.workspaceId),
        });
        const actions: ChannelActions = {
          fail: (error) => this.fail(id, error),
          cancel: () => this.cancel(id),
        };
        if (params.mode === "tty") {
          if (params.history !== undefined)
            throw new AppError("invalid_argument", "TTY attach does not accept history");
          channel.backend = new TtyBackend(
            channel,
            {
              cols: parseTerminalCols(params.cols),
              rows: parseTerminalRows(params.rows),
              term: string(params.term, "term"),
            },
            { ...actions, isCurrent: () => this.entries.get(id) === channel },
          );
        } else {
          if (params.mode !== undefined && params.mode !== "web")
            throw new AppError("invalid_argument", "Invalid terminal mode");
          const history = params.history === undefined ? "retained" : params.history;
          if (history !== "retained" && history !== "screen")
            throw new AppError("invalid_argument", "Invalid history range");
          if (status.webStatus !== "available")
            throw new AppError("recording_unavailable", "Terminal recording is unavailable");
          channel.backend = new WebBackend(channel, this.sessions.recorder, history, actions);
        }
        sendFrame(
          socket,
          JSON.stringify({
            type: "ready",
            meta: {
              terminalInputBytes: this.config.limits.terminalInputBytes,
            },
          }),
        );
      } catch (error) {
        this.fail(id, error);
      }
    });
    socket.on("message", (raw, binary) => {
      try {
        if (this.entries.get(id) !== channel) return;
        const message = binary ? undefined : record(JSON.parse(raw.toString()));
        if (!channel.started) {
          if (message?.type !== "start")
            throw new AppError("invalid_argument", "Channel has not started");
          const target = this.sessions.channelStartTarget(channel.sessionId);
          channel.backend!.start(target);
          channel.started = true;
          return;
        }
        let input: TerminalInput;
        if (binary) {
          if ((raw as Buffer).length > limits.dataChunkBytes)
            throw new AppError("limit_exceeded", "Input frame is too large");
          input = Buffer.from(raw as Buffer);
        } else if (message?.type === "paste") {
          if (typeof message.text !== "string")
            throw new AppError("invalid_argument", "Invalid paste content");
          input = { type: "paste", text: message.text };
        } else if (message?.type === "resize")
          input = {
            type: "resize",
            cols: parseTerminalCols(message.cols),
            rows: parseTerminalRows(message.rows),
          };
        else if (message?.type === "consumed")
          input = {
            type: "consumed",
            bytes: integer(message.bytes, "bytes", 0, Number.MAX_SAFE_INTEGER),
          };
        else throw new AppError("invalid_argument", "Invalid terminal input");
        channel.backend!.input(input);
      } catch (error) {
        if (!channel.started || !(channel.backend instanceof WebBackend)) {
          this.fail(id, error);
          return;
        }
        channel.backend.inputFailed(error);
      }
    });
    socket.on("error", () => this.cancel(id));
    socket.on("close", () => this.cancel(id));
  }
  frame(message: RecorderMessage) {
    if (message.type === "fault") {
      for (const item of this.entries.values())
        if (item.backend instanceof WebBackend && item.sessionId === message.sessionId)
          this.fail(item.id, new AppError(message.error.code, message.error.message));
      return;
    }
    if (message.type !== "bytes" && message.type !== "frame") return;
    const channel = this.entries.get(message.attachmentId);
    if (!(channel?.backend instanceof WebBackend) || channel.sessionId !== message.sessionId)
      return;
    channel.backend.frame(message);
  }
  private fail(id: string, error: unknown) {
    const channel = this.entries.get(id);
    if (channel?.socket.readyState === WebSocket.OPEN)
      channel.socket.send(JSON.stringify({ type: "error", ...asError(error) }));
    this.cancel(id);
  }
  cancel(id: string) {
    const channel = this.entries.get(id);
    if (!channel) return;
    this.entries.delete(id);
    const stopped = channel.backend?.close();
    if (stopped) {
      this.closing.add(stopped);
      void stopped
        .catch((error: unknown) => console.error("Terminal client cleanup failed:", error))
        .finally(() => this.closing.delete(stopped));
    }
    channel.socket.close(1000);
  }
  async close() {
    for (const id of this.entries.keys()) this.cancel(id);
    await Promise.all(this.closing);
  }
}
