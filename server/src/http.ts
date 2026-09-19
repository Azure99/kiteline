import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, appVersion, asError, limits } from "@kiteline/shared/protocol";

export function requireVersion(clientVersion: string | null, component: "agent" | "web") {
  if (clientVersion !== appVersion) throw versionMismatch(clientVersion, component);
}
export function versionMismatch(clientVersion: string | null, component: "agent" | "web") {
  return new AppError(
    "version_mismatch",
    `${component} version ${clientVersion ?? "unknown"} does not match server ${appVersion}. Use the matching release.`,
    { component, clientVersion, serverVersion: appVersion },
  );
}

export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
export async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of request) {
    size += part.length;
    if (size > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "Request exceeds the size limit");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new AppError("invalid_argument", "Invalid JSON");
  }
}
export function cookie(request: IncomingMessage) {
  return request.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("kiteline_session="))
    ?.slice("kiteline_session=".length);
}
export function origin(request: IncomingMessage, expected: string) {
  if (request.headers.origin !== expected) throw new AppError("forbidden", "Origin mismatch");
}
export function errorStatus(error: unknown) {
  const statuses: Record<string, number> = {
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    busy: 429,
    limit_exceeded: 413,
    invalid_argument: 400,
    offline: 503,
    version_mismatch: 426,
  };
  return statuses[asError(error).code] ?? 500;
}
export function failure(response: ServerResponse, error: unknown) {
  if (response.headersSent) response.destroy();
  else json(response, errorStatus(error), { error: asError(error) });
}
export class AttemptLimiter {
  private sources = new Map<string, { count: number; until: number }>();
  private count = 0;
  private until = 0;
  check(source: string) {
    const now = Date.now();
    if (now >= this.until) {
      this.count = 0;
      this.until = now + 60_000;
    }
    const previous = this.sources.get(source);
    const current = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };
    if (this.count >= 30 || current.count >= 10)
      throw new AppError("busy", "Too many attempts; try again later");
    if (this.sources.size >= 1024 && !this.sources.has(source))
      this.sources.delete(this.sources.keys().next().value!);
    this.count++;
    current.count++;
    this.sources.set(source, current);
  }
}
