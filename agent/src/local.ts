import { createServer, request, type Server } from "node:http";
import { createHash } from "node:crypto";
import { chmod, realpath, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { PrivatePipe, connectPrivatePipe } from "@kiteline/shared/windows/pipe";
import { windowsNative } from "@kiteline/shared/windows/native";
import {
  AppError,
  OperationError,
  asError,
  errorReply,
  limits,
  record,
  rpcMutates,
  string,
  type Reply,
  type RpcMethod,
} from "@kiteline/shared/protocol";
import type { AgentConfig } from "./config.js";

async function localEndpoint(runDir: string) {
  if (process.platform !== "win32") return join(runDir, "agent.sock");
  const identity = windowsNative().identity();
  const name = createHash("sha256")
    .update(identity.sid)
    .update("\0")
    .update(await realpath(runDir))
    .digest("hex");
  return `\\\\.\\pipe\\kiteline-${name}`;
}

export class LocalServer {
  private server?: Server;
  private socketPath?: string;
  private pipe?: PrivatePipe;
  private readonly connections = new Set<Socket>();
  private closing?: Promise<void>;
  constructor(
    private config: AgentConfig,
    private dispatch: (
      method: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  async start() {
    if (process.platform === "win32") windowsNative().privateDirectory(this.config.runDir);
    this.socketPath = await localEndpoint(this.config.runDir);
    if (process.platform !== "win32") {
      if (Buffer.byteLength(this.socketPath) > 103)
        throw new AppError("invalid_argument", "KITELINE_AGENT_RUN_DIR path is too long");
      await rm(this.socketPath, { force: true });
    }
    const server = createServer(async (request, response) => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new AppError("timeout", "Local operation timed out")),
        this.config.limits.rpcTimeout,
      );
      response.on("close", () => {
        if (!response.writableEnded)
          controller.abort(new AppError("cancelled", "Local request disconnected"));
      });
      try {
        if (request.method !== "POST" || request.url !== "/rpc")
          throw new AppError("not_found", "Unknown local endpoint");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const part of request) {
          const chunk = Buffer.from(part as Uint8Array);
          bytes += chunk.length;
          if (bytes > limits.controlMessageBytes)
            throw new AppError("limit_exceeded", "Local request is too large");
          chunks.push(chunk);
        }
        const body = record(JSON.parse(Buffer.concat(chunks).toString()));
        const result = await this.dispatch(
          string(body.method),
          record(body.params),
          controller.signal,
        );
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "local", outcome: "succeeded", result }));
      } catch (error) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(errorReply("local", error)));
      } finally {
        clearTimeout(timeout);
      }
    });
    this.server = server;
    if (process.platform === "win32") {
      server.setTimeout(this.config.limits.rpcTimeout);
      this.pipe = new PrivatePipe(
        this.socketPath,
        (socket) => {
          this.connections.add(socket);
          socket.once("close", () => this.connections.delete(socket));
          server.emit("connection", socket);
        },
        (error) => {
          console.error("Local pipe failed:", error);
          void this.close().catch((error: unknown) => console.error(error));
        },
      );
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
  }
  close() {
    return (this.closing ??= this.finishClose());
  }
  private async finishClose() {
    const server = this.server;
    if (!server) return;
    if (process.platform === "win32") {
      try {
        await this.pipe?.close();
      } finally {
        // HTTP does not track sockets delivered without server.listen().
        await Promise.all(
          [...this.connections].map(async (socket) => {
            const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
            socket.destroy();
            await closed;
          }),
        );
      }
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.socketPath!, { force: true });
  }
}

export async function localRequest<T>(
  config: Pick<AgentConfig, "runDir"> & { limits: Pick<AgentConfig["limits"], "rpcTimeout"> },
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const signal = AbortSignal.timeout(config.limits.rpcTimeout + 1000);
  const endpoint = await localEndpoint(config.runDir);
  const socket =
    process.platform === "win32" ? await connectPrivatePipe(endpoint, signal) : undefined;
  return new Promise((resolve, reject) => {
    let sent = false;
    const fail = (error: unknown) => {
      const detail = asError(error);
      reject(
        sent && rpcMutates[method as RpcMethod]
          ? new OperationError(detail.code, detail.message, "unknown", undefined, detail.details)
          : error,
      );
    };
    const client = request(
      {
        socketPath: endpoint,
        createConnection: socket ? () => socket : undefined,
        method: "POST",
        path: "/rpc",
        headers: { "content-type": "application/json" },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.controlMessageBytes)
            response.destroy(new Error("Local result is too large"));
          else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString()) as Reply<T>;
            if (reply.outcome === "succeeded") resolve(reply.result);
            else
              reject(
                new OperationError(
                  reply.error.code,
                  reply.error.message,
                  reply.outcome,
                  reply.result,
                  reply.error.details,
                ),
              );
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    client.on("finish", () => {
      sent = true;
    });
    client.on("error", fail);
    client.end(JSON.stringify({ method, params }));
  });
}
