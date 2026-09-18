import { WebSocket } from "ws";
import {
  AppError,
  asError,
  integer,
  limits,
  record,
  string,
  terminalProfile,
} from "@kiteline/shared/protocol";
import type { RecorderMessage, RecorderRequest } from "@kiteline/shared/ipc";
import { heartbeat, sendFrame } from "@kiteline/shared/ws";
import type { AgentConfig, Identity } from "../config.js";
import type { Sessions } from "./sessions.js";

interface Channel {
  id: string;
  sessionId: string;
  params: Record<string, unknown>;
  socket: WebSocket;
  timer: NodeJS.Timeout;
  started: boolean;
  admitted: boolean;
}
export class TerminalChannels {
  private entries = new Map<string, Channel>();
  constructor(
    private sessions: Sessions,
    private config: AgentConfig,
    private identity: Identity,
    private otherChannels: () => number = () => 0,
  ) {
    sessions.onFrame = (message) => this.frame(message);
  }
  get count() {
    return [...this.entries.values()].filter((item) => item.admitted).length;
  }
  open(id: string, connectionId: string, kind: string, params: Record<string, unknown>) {
    if (this.entries.has(id)) throw new AppError("conflict", "通道已存在");
    const admitted = this.count + this.otherChannels() < this.config.limits.channelsPerDevice;
    const url = new URL(`/api/agent/channels/${encodeURIComponent(id)}`, this.identity.server);
    url.protocol = "wss:";
    url.searchParams.set("connectionId", connectionId);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.identity.deviceToken}` },
      maxPayload: limits.controlMessageBytes,
      handshakeTimeout: this.config.limits.channelPairTimeout,
    });
    const channel: Channel = {
      id,
      sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
      params,
      socket,
      started: false,
      admitted,
      timer: setTimeout(
        () => this.fail(id, new AppError("timeout", "等待通道配对超时")),
        this.config.limits.channelPairTimeout,
      ),
    };
    this.entries.set(id, channel);
    socket.on("upgrade", (response) =>
      response.socket.setKeepAlive(true, limits.tcpKeepAliveDelayMs),
    );
    socket.on("open", () => {
      heartbeat(socket);
      try {
        if (!admitted) throw new AppError("busy", "设备通道已满");
        if (kind !== "terminal.attach") throw new AppError("unsupported", "不支持的数据通道");
        const item = this.sessions.get(string(params.sessionId), string(params.workspaceId));
        if (params.terminalProfile !== terminalProfile)
          throw new AppError("unsupported", "终端组件版本不同，请统一升级");
        if (
          params.history !== undefined &&
          params.history !== "retained" &&
          params.history !== "screen"
        )
          throw new AppError("invalid_argument", "无效历史范围");
        if (item.session.state !== "running") throw new AppError("busy", "终端仍在创建");
        if (item.session.webStatus !== "available")
          throw new AppError("recording_unavailable", "终端记录不可用");
        sendFrame(
          socket,
          JSON.stringify({
            type: "ready",
            meta: {
              sessionId: item.session.id,
              historyLines: item.session.historyLines,
              terminalProfile,
              terminalInputBytes: this.config.limits.terminalInputBytes,
              controlMessageBytes: limits.controlMessageBytes,
            },
          }),
        );
        clearTimeout(channel.timer);
        channel.timer = setTimeout(
          () => this.fail(id, new AppError("timeout", "等待通道 start 超时")),
          this.config.limits.channelPairTimeout,
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
          if (message?.type !== "start") throw new AppError("invalid_argument", "通道尚未开始");
          const item = this.sessions.get(channel.sessionId);
          if (item.session.webStatus !== "available")
            throw new AppError("recording_unavailable", "终端记录不可用");
          channel.started = true;
          clearTimeout(channel.timer);
          void this.sessions.recorder
            .request({
              type: "attach",
              sessionId: channel.sessionId,
              attachmentId: id,
              terminalProfile,
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
            throw new AppError("limit_exceeded", "输入帧过大");
          command = {
            type: "input",
            ...target,
            dataBase64: Buffer.from(raw as Buffer).toString("base64"),
          };
        } else if (message?.type === "paste") {
          if (typeof message.text !== "string")
            throw new AppError("invalid_argument", "粘贴内容无效");
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
        else throw new AppError("invalid_argument", "无效终端输入");
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
    clearTimeout(channel.timer);
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
