import {
  rpcMutates,
  type KitelineError,
  type RpcArguments,
  type RpcReply,
  type RpcResult,
} from "@kiteline/shared/protocol";
import { i18n } from "../i18n";
import { en } from "../i18n/en";
import { observeServerVersion, versionedPath } from "./release";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public outcome?: string,
    public details?: unknown,
    public result?: unknown,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  mutation = !!options.method && !["GET", "HEAD"].includes(options.method),
): Promise<T> {
  try {
    const response = await fetch(versionedPath(path), {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
    observeServerVersion(response.headers.get("x-kiteline-version"));
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = (data as { error: KitelineError }).error;
      if (response.status === 401) window.dispatchEvent(new Event("kiteline:unauthenticated"));
      throw new ApiError(error.code, error.message, undefined, error.details);
    }
    return data as T;
  } catch (error) {
    if (!mutation || error instanceof ApiError) throw error;
    throw new ApiError("io_error", "No operation result was received", "unknown");
  }
}
export function post<T>(path: string, value: unknown = {}, signal?: AbortSignal, mutation = true) {
  return api<T>(path, { method: "POST", body: JSON.stringify(value), signal }, mutation);
}
export function rpcReply<A extends RpcArguments>(
  deviceId: string,
  id: string,
  [method, params, signal]: A,
): Promise<RpcReply<A[0]>> {
  return post<RpcReply<A[0]>>(
    `/api/devices/${encodeURIComponent(deviceId)}/rpc`,
    { id, method, params },
    signal,
    rpcMutates[method],
  );
}
export async function rpc<A extends RpcArguments>(
  deviceId: string,
  ...args: A
): Promise<RpcResult<A[0]>> {
  const reply = await rpcReply(deviceId, crypto.randomUUID(), args);
  if (reply.outcome !== "succeeded")
    throw new ApiError(
      reply.error.code,
      reply.error.message,
      reply.outcome,
      reply.error.details,
      reply.result,
    );
  return reply.result;
}
export function errorMessage(error: unknown, context?: "login") {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ApiError ? error.code : undefined;
  const summary =
    context === "login" && code === "unauthenticated"
      ? i18n.t(($) => $.auth.invalidCredentials)
      : code && Object.hasOwn(en.errors, code)
        ? i18n.t(($) => $.errors[code as keyof typeof en.errors])
        : i18n.t(($) => $.errors.requestFailed);
  const outcome =
    error instanceof ApiError && (error.outcome === "unknown" || error.outcome === "partial")
      ? i18n.t(($) => $.errors[error.outcome as "unknown" | "partial"])
      : "";
  return [summary, code ? `[${code}] ${message}` : message, outcome].filter(Boolean).join(" ");
}
