import { WebSocket } from "ws";
import { AppError, asError, integer, limits, record, string } from "@kiteline/shared/protocol";
import type { RecorderMessage, RecorderRequest } from "@kiteline/shared/protocol/ipc";
import { heartbeat, sendFrame } from "@kiteline/shared/protocol/ws";
import type { AgentConfig, Identity } from "../config.js";
import type { Sessions } from "./sessions.js";
import { connectServerSocket } from "../network.js";

interface Channel {
  id: string;
  sessionId: string;
  socket: WebSocket;
  started: boolean;
}
export class TerminalChannels {
  private entries = new Map<string, Channel>();
  constructor(
    private sessions: Sessions,
    private config: AgentConfig,
    private identity: Identity,
  ) {
    sessions.onFrame = (message) => this.frame(message);
  }
  open(id: string, connectionId: string, kind: string, params: Record<string, unknown>) {
    if (this.entries.has(id)) throw new AppError("conflict", "Channel already exists");
    const url = new URL(`/api/agent/channels/${encodeURIComponent(id)}`, this.identity.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("connectionId", connectionId);
    const socket = connectServerSocket(url, {
      headers: { authorization: `Bearer ${this.identity.deviceToken}` },
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
        if (kind !== "terminal.attach")
          throw new AppError("unsupported", "Unsupported data channel");
        const item = this.sessions.get(string(params.sessionId), string(params.workspaceId));
        if (
          params.history !== undefined &&
          params.history !== "retained" &&
          params.history !== "screen"
        )
          throw new AppError("invalid_argument", "Invalid history range");
        if (item.session.state !== "running")
          throw new AppError("busy", "Terminal is still being created");
        if (item.session.webStatus !== "available")
          throw new AppError("recording_unavailable", "Terminal recording is unavailable");
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
          const item = this.sessions.get(channel.sessionId);
          if (item.session.webStatus !== "available")
            throw new AppError("recording_unavailable", "Terminal recording is unavailable");
          channel.started = true;
          void this.sessions.recorder
            .request({
              type: "attach",
              sessionId: channel.sessionId,
              attachmentId: id,
              history: params.history === "screen" ? "screen" : "retained",
              historyGap: item.session.historyGap,
            })
            .catch((error: unknown) => this.fail(id, error));
          return;
        }
        let command: RecorderRequest;
        const target = { sessionId: channel.sessionId, attachmentId: id };
        if (binary) {
          if ((raw as Buffer).length > limits.dataChunkBytes)
            throw new AppError("limit_exceeded", "Input frame is too large");
          command = {
            type: "input",
            ...target,
            dataBase64: Buffer.from(raw as Buffer).toString("base64"),
          };
        } else if (message?.type === "paste") {
          if (typeof message.text !== "string")
            throw new AppError("invalid_argument", "Invalid paste content");
          command = { type: "paste", ...target, text: message.text };
        } else if (message?.type === "resize")
          command = {
            type: "resize",
            ...target,
            cols: integer(message.cols, "cols", 1, limits.terminalMaxCols),
            rows: integer(message.rows, "rows", 1, limits.terminalMaxRows),
          };
        else if (message?.type === "consumed")
          command = {
            type: "consumed",
            ...target,
            bytes: integer(message.bytes, "bytes", 0, Number.MAX_SAFE_INTEGER),
          };
        else throw new AppError("invalid_argument", "Invalid terminal input");
        this.sessions.recorder.send(command);
      } catch (error) {
        if (!channel.started) {
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
  private frame(message: RecorderMessage) {
    if (message.type === "fault") {
      for (const item of this.entries.values())
        if (item.sessionId === message.sessionId)
          this.fail(item.id, new AppError(message.error.code, message.error.message));
      return;
    }
    if (message.type !== "bytes" && message.type !== "frame") return;
    const channel = this.entries.get(message.attachmentId);
    if (!channel || channel.sessionId !== message.sessionId) return;
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
    try {
      this.sessions.recorder.detach(channel.sessionId, id);
    } catch {
      /* Recorder failure already closes its displays. */
    }
    channel.socket.close(1000);
  }
  close() {
    for (const id of this.entries.keys()) this.cancel(id);
  }
}
