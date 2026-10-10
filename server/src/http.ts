import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import {
  AppError,
  appVersion,
  asError,
  limits,
  record,
  string,
  type Reply,
} from "@kiteline/shared/protocol";

function bearer(request: IncomingMessage) {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer "))
    throw new AppError("unauthenticated", "Missing device credentials");
  return value.slice(7);
}
export function requireAgent(store: Store, request: IncomingMessage) {
  const device = store.authenticateAgent(bearer(request));
  if (!device) throw new AppError("unauthenticated", "Invalid device credentials");
  return device;
}
export function requireLogin(store: Store, request: IncomingMessage, entryOrigin: string) {
  const login = store.login(loginCookieToken(request, entryOrigin));
  if (!login) throw new AppError("unauthenticated", "Please sign in");
  return login;
}

export function rawHead(status: number, message: string, headers: OutgoingHttpHeaders) {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [key, value] of Object.entries(headers))
    if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

export function parseReplyError(value: unknown) {
  const error = record(value);
  const code = string(error.code);
  if (typeof error.message !== "string")
    throw new AppError("invalid_argument", "Expected a diagnostic string");
  return new AppError(code, error.message, error.details);
}

export function checkReply(reply: Record<string, unknown>): Reply {
  if (
    typeof reply.outcome !== "string" ||
    !["succeeded", "failed", "partial", "unknown"].includes(reply.outcome)
  )
    throw new AppError("invalid_argument", "Invalid reply");
  if (reply.outcome !== "succeeded") parseReplyError(reply.error);
  return reply as unknown as Reply;
}

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

export function decodePath(value: string, message = "Invalid URL path") {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError("invalid_argument", message);
  }
}

export function closeIfBodyUnread(response: ServerResponse) {
  const request = response.req;
  if (
    !request.complete &&
    (request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? 0) > 0)
  )
    response.setHeader("connection", "close");
}

export function json(response: ServerResponse, status: number, value: unknown) {
  closeIfBodyUnread(response);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
export async function body(request: IncomingMessage): Promise<unknown> {
  const timer = setTimeout(
    () => request.destroy(new AppError("timeout", "JSON body reception timed out")),
    30_000,
  ).unref();
  try {
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
  } finally {
    clearTimeout(timer);
  }
}
export function requestOrigin(request: IncomingMessage, trustProxyProto: boolean) {
  const host = request.headers.host;
  const protocol = trustProxyProto ? (request.headers["x-forwarded-proto"] ?? "http") : "http";
  if (protocol !== "http" && protocol !== "https")
    throw new AppError("invalid_argument", "Invalid X-Forwarded-Proto");
  if (!host || request.headersDistinct.host?.length !== 1 || /[\s/@?#,\\]/.test(host))
    throw new AppError("invalid_argument", "Invalid Host header");
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new AppError("invalid_argument", "Invalid Host header");
  }
}
export const loginCookieNames = ["kiteline_session", "kiteline_session_http"] as const;
function cookieName(entryOrigin: string) {
  return entryOrigin.startsWith("https:") ? loginCookieNames[0] : loginCookieNames[1];
}
export function loginCookie(entryOrigin: string, token: string, expiresAt: string) {
  const secure = entryOrigin.startsWith("https:") ? " Secure;" : "";
  const expiry = token ? `Expires=${new Date(expiresAt).toUTCString()}` : "Max-Age=0";
  return `${cookieName(entryOrigin)}=${token}; Path=/; HttpOnly;${secure} SameSite=Strict; ${expiry}`;
}
function loginCookieToken(request: IncomingMessage, entryOrigin: string) {
  const prefix = cookieName(entryOrigin) + "=";
  return request.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix))
    ?.slice(prefix.length);
}
export function requireOrigin(request: IncomingMessage, expected: string) {
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
    unsupported: 400,
    permission_denied: 403,
    timeout: 504,
    offline: 503,
    version_mismatch: 426,
  };
  const code = asError(error).code;
  return Object.hasOwn(statuses, code) ? statuses[code]! : 500;
}
export function serverError(error: unknown) {
  if (error instanceof AppError) return error;
  console.error(
    "Unexpected server error:",
    error instanceof Error ? (error.stack ?? error.message) : "Non-Error exception",
  );
  return new AppError("io_error", "Internal server error");
}
export function failure(response: ServerResponse, cause: unknown) {
  const error = serverError(cause);
  if (response.destroyed) return;
  if (response.headersSent) response.destroy();
  else json(response, errorStatus(error), { error: asError(error) });
}
export class AttemptLimiter {
  private sources = new Map<string, { count: number; until: number }>();
  private count = 0;
  private until = 0;
  check(source: string) {
    const now = Date.now();
    const windowEnd = now + 60_000;
    if (now >= this.until) {
      this.count = 0;
      this.until = windowEnd;
    }
    const previous = this.sources.get(source);
    const current = previous && previous.until > now ? previous : { count: 0, until: windowEnd };
    if (this.count >= 30 || current.count >= 10)
      throw new AppError("busy", "Too many attempts; try again later");
    if (this.sources.size >= 1024 && !this.sources.has(source))
      this.sources.delete(this.sources.keys().next().value!);
    this.count++;
    current.count++;
    this.sources.set(source, current);
  }
}
