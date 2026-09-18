import { createServer, request, type Server } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  errorReply,
  limits,
  record,
  string,
  type Reply,
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
      throw new AppError("invalid_argument", "KITELINE_AGENT_RUN_DIR 路径过长");
    await rm(this.socketPath, { force: true });
    const server = createServer(async (request, response) => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new AppError("timeout", "本机操作超时")),
        this.config.limits.rpcTimeout,
      );
      response.on("close", () => {
        if (!response.writableEnded) controller.abort(new AppError("cancelled", "本机请求已断开"));
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
            throw new AppError("limit_exceeded", "本机请求过大");
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
  config: AgentConfig,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
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
          if (bytes > limits.controlMessageBytes) response.destroy(new Error("本机结果过大"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString()) as Reply<T>;
            if (reply.outcome === "succeeded") resolve(reply.result);
            else
              reject(
                new AppError(reply.error.code, reply.error.message, {
                  outcome: reply.outcome,
                  result: reply.result,
                }),
              );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    client.on("error", reject);
    client.end(JSON.stringify({ method, params }));
  });
}
