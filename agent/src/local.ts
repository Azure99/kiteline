import { createServer, request, type Server } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
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

export class LocalServer {
  private server?: Server;
  private readonly socketPath: string;
  constructor(
    private config: AgentConfig,
    private dispatch: (
      method: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    this.socketPath = join(config.runDir, "agent.sock");
  }
  async start() {
    if (Buffer.byteLength(this.socketPath) > 103)
      throw new AppError("invalid_argument", "KITELINE_AGENT_RUN_DIR path is too long");
    await rm(this.socketPath, { force: true });
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
  }
  async close() {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }
}

export function localRequest<T>(
  config: Pick<AgentConfig, "runDir"> & { limits: Pick<AgentConfig["limits"], "rpcTimeout"> },
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
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
        socketPath: join(config.runDir, "agent.sock"),
        method: "POST",
        path: "/rpc",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.limits.rpcTimeout + 1000),
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
