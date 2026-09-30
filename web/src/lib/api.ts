import { newId } from "./id";
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
  retryable = false;
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
export function apiError(error: KitelineError, outcome?: string, result?: unknown) {
  return new ApiError(error.code, error.message, outcome, error.details, result);
}
const gatewayStatuses = new Set([502, 503, 504]);
export async function api<T>(
  path: string,
  options: RequestInit = {},
  mutation = !!options.method && !["GET", "HEAD"].includes(options.method),
): Promise<T> {
  let response: Response | undefined;
  try {
    response = await fetch(versionedPath(path), {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
    observeServerVersion(response.headers.get("x-kiteline-version"));
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = (data as { error?: KitelineError } | null)?.error;
      if (typeof error?.code !== "string" || typeof error.message !== "string")
        throw new Error(`Invalid HTTP ${response.status} error response`);
      if (response.status === 401) window.dispatchEvent(new Event("kiteline:unauthenticated"));
      const failure = apiError(error);
      failure.retryable = gatewayStatuses.has(response.status);
      throw failure;
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (mutation) throw new ApiError("io_error", "No operation result was received", "unknown");
    if (options.signal?.aborted) throw error;
    if (response ? gatewayStatuses.has(response.status) : error instanceof TypeError) {
      const failure = new ApiError(
        "io_error",
        response ? `HTTP ${response.status} ${response.statusText}` : (error as Error).message,
      );
      failure.retryable = true;
      throw failure;
    }
    throw error;
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
  const reply = await rpcReply(deviceId, newId(), args);
  if (reply.outcome !== "succeeded") throw apiError(reply.error, reply.outcome, reply.result);
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
