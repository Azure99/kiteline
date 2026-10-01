import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { AppError, asError, integer, limits, record } from "@kiteline/shared/protocol";
import { httpStream } from "@kiteline/shared/http-stream";
import type { Identity } from "../config.js";
import { connectServerSocket } from "../network.js";

interface Channel {
  socket: WebSocket;
  local?: Socket;
  stream?: Duplex;
  ready: boolean;
}

export class HttpChannels {
  private entries = new Map<string, Channel>();
  constructor(private identity: Identity) {}
  open(id: string, connectionId: string, _kind: string, params: Record<string, unknown>) {
    const url = new URL(`/api/agent/channels/${encodeURIComponent(id)}`, this.identity.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("connectionId", connectionId);
    const socket = connectServerSocket(url, {
      headers: { authorization: `Bearer ${this.identity.deviceToken}` },
      maxPayload: limits.dataChunkBytes,
      finishRequest(request) {
        request.setSocketKeepAlive(true, limits.tcpKeepAliveDelayMs);
        request.end();
      },
    });
    const item: Channel = {
      socket,
      ready: false,
    };
    this.entries.set(id, item);
    const start = (raw: Buffer, binary: boolean) => {
      try {
        if (binary || !item.ready || record(JSON.parse(raw.toString())).type !== "start")
          throw new AppError("invalid_argument", "HTTP channel is not ready");
        socket.off("message", start);
        item.stream = httpStream(socket, (error) => this.fail(id, error));
        item.local!.pipe(item.stream).pipe(item.local!);
      } catch (error) {
        this.fail(id, error);
      }
    };
    socket.on("message", start);
    socket.on("error", (error) => this.fail(id, error));
    socket.on("close", () => this.cancel(id));
    socket.on("open", () => {
      if (this.entries.get(id) !== item) return socket.terminate();
      try {
        const port = integer(params.port, "port", 1, 65535);
        const dial = (host: string) => {
          const local = connect({ host, port });
          item.local = local;
          let connected = false;
          local.once("connect", () => {
            connected = true;
            if (this.entries.get(id) !== item) return local.destroy();
            local.setKeepAlive(true, limits.tcpKeepAliveDelayMs);
            item.ready = true;
            socket.send(JSON.stringify({ type: "ready", meta: {} }));
          });
          local.on("error", (error) => {
            if (this.entries.get(id) !== item) return;
            if (!connected && host === "127.0.0.1") dial("::1");
            else this.fail(id, error);
          });
          local.on("close", () => {
            if (this.entries.get(id) === item && connected && !item.stream)
              this.fail(
                id,
                new AppError("io_error", "Local service closed the connection before the request"),
              );
          });
        };
        dial("127.0.0.1");
      } catch (error) {
        this.fail(id, error);
      }
    });
  }
  private fail(id: string, error: unknown) {
    const item = this.entries.get(id);
    if (!item) return;
    if (!item.stream && item.socket.readyState === WebSocket.OPEN) {
      const detail = asError(error);
      item.socket.send(
        JSON.stringify({ type: "error", code: detail.code, message: detail.message }),
      );
      this.dispose(id, false);
      item.socket.close(1000);
    } else this.cancel(id);
  }
  private dispose(id: string, terminate: boolean) {
    const item = this.entries.get(id);
    if (!item) return;
    this.entries.delete(id);
    item.local?.destroy();
    item.stream?.destroy();
    if (terminate) item.socket.terminate();
  }
  cancel(id: string) {
    this.dispose(id, true);
  }
  close() {
    for (const id of this.entries.keys()) this.cancel(id);
  }
}
