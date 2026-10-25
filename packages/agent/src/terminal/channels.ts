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

interface Channel {
  id: string;
  sessionId: string;
  socket: WebSocket;
  started: boolean;
  backend?:
    | { mode: "web" }
    | {
        mode: "tty";
        options: { cols: number; rows: number; term: string };
        bridge?: Promise<TtyBridge>;
      };
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
        if (params.mode === "tty") {
          if (params.history !== undefined)
            throw new AppError("invalid_argument", "TTY attach does not accept history");
          channel.backend = {
            mode: "tty",
            options: {
              cols: parseTerminalCols(params.cols),
              rows: parseTerminalRows(params.rows),
              term: string(params.term, "term"),
            },
          };
        } else {
          if (params.mode !== undefined && params.mode !== "web")
            throw new AppError("invalid_argument", "Invalid terminal mode");
          if (
            params.history !== undefined &&
            params.history !== "retained" &&
            params.history !== "screen"
          )
            throw new AppError("invalid_argument", "Invalid history range");
          if (status.webStatus !== "available")
            throw new AppError("recording_unavailable", "Terminal recording is unavailable");
          channel.backend = { mode: "web" };
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
          if (channel.backend?.mode === "tty") {
            channel.started = true;
            socket.pause();
            channel.backend.bridge = TtyBridge.start(
              target.socket,
              channel.backend.options,
              (data) => sendFrame(socket, data),
              () => {
                try {
                  sendFrame(
                    socket,
                    JSON.stringify({ type: "ended", exitCode: 0 } satisfies TtyFrame),
                  );
                } catch (error) {
                  this.fail(id, error);
                } finally {
                  this.cancel(id);
                }
              },
              (error) => this.fail(id, error),
            );
            void channel.backend.bridge.then(
              () => socket.resume(),
              (error: unknown) => {
                socket.resume();
                this.fail(id, error);
              },
            );
            return;
          }
          if (target.webStatus !== "available")
            throw new AppError("recording_unavailable", "Terminal recording is unavailable");
          channel.started = true;
          void this.sessions.recorder
            .request({
              type: "attach",
              sessionId: channel.sessionId,
              attachmentId: id,
              history: params.history === "screen" ? "screen" : "retained",
              historyGap: target.historyGap,
            })
            .catch((error: unknown) => this.fail(id, error));
          return;
        }
        let input: Buffer | BrowserTerminalInput;
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
        if (channel.backend?.mode === "tty") {
          void channel.backend.bridge!.then(
            (bridge) => {
              if (this.entries.get(id) !== channel) return;
              try {
                if (Buffer.isBuffer(input)) bridge.input(input);
                else if (input.type === "resize") bridge.resize(input.cols, input.rows);
                else if (input.type === "consumed") bridge.acknowledge(input.bytes);
                else throw new AppError("invalid_argument", "Invalid TTY input");
              } catch (error) {
                this.fail(id, error);
              }
            },
            (error: unknown) => this.fail(id, error),
          );
        } else
          this.sessions.recorder.send({
            sessionId: channel.sessionId,
            attachmentId: id,
            ...(Buffer.isBuffer(input)
              ? { type: "input", dataBase64: input.toString("base64") }
              : input),
          });
      } catch (error) {
        if (!channel.started || channel.backend?.mode === "tty") {
          this.fail(id, error);
          return;
        }
        try {
          sendFrame(
            socket,
            JSON.stringify({ type: "input.error", ...asError(error), outcome: "failed" }),
          );
        } catch {
          this.cancel(id);
        }
      }
    });
    socket.on("error", () => this.cancel(id));
    socket.on("close", () => this.cancel(id));
  }
  frame(message: RecorderMessage) {
    if (message.type === "fault") {
      for (const item of this.entries.values())
        if (item.backend?.mode === "web" && item.sessionId === message.sessionId)
          this.fail(item.id, new AppError(message.error.code, message.error.message));
      return;
    }
    if (message.type !== "bytes" && message.type !== "frame") return;
    const channel = this.entries.get(message.attachmentId);
    if (channel?.backend?.mode !== "web" || channel.sessionId !== message.sessionId) return;
    try {
      sendFrame(
        channel.socket,
        message.type === "bytes"
          ? Buffer.from(message.dataBase64, "base64")
          : JSON.stringify(message.frame),
      );
      if (
        message.type === "frame" &&
        (message.frame.type === "ended" || message.frame.type === "error")
      )
        this.cancel(channel.id);
    } catch (error) {
      this.fail(channel.id, error);
    }
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
    if (channel.backend?.mode === "tty") {
      const stopped = channel.backend.bridge?.then(
        (bridge) => bridge.stop(),
        () => {}, // spawnJob already cleans up a failed startup.
      );
      if (stopped) {
        this.closing.add(stopped);
        void stopped
          .catch((error: unknown) => console.error("Terminal client cleanup failed:", error))
          .finally(() => this.closing.delete(stopped));
      }
    } else if (channel.backend?.mode === "web") {
      try {
        this.sessions.recorder.detach(channel.sessionId, id);
      } catch {
        /* Recorder failure already closes its displays. */
      }
    }
    channel.socket.close(1000);
  }
  async close() {
    for (const id of this.entries.keys()) this.cancel(id);
    await Promise.all(this.closing);
  }
}
