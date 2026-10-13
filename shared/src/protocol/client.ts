import {
  appVersion,
  rpcMutates,
  type KitelineError,
  type RpcArguments,
  type RpcReply,
  type RpcResult,
} from "./index.js";

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

export function versionedPath(path: string) {
  const url = new URL(path, "https://kiteline.invalid");
  url.searchParams.set("appVersion", appVersion);
  return url.pathname + url.search;
}

interface ClientHost {
  request<T>(
    path: string,
    options: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T>;
  newId(): string;
  observeServerVersion?(version: string | null): void;
  unauthenticated?(): void;
}

export function createApiClient(host: ClientHost) {
  async function api<T>(
    path: string,
    options: RequestInit = {},
    mutation = !!options.method && !["GET", "HEAD"].includes(options.method),
  ): Promise<T> {
    let response: Response | undefined;
    try {
      return await host.request(
        versionedPath(path),
        {
          ...options,
          headers: {
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...options.headers,
          },
        },
        async (received) => {
          response = received;
          host.observeServerVersion?.(response.headers.get("x-kiteline-version"));
          const data: unknown = await response.json();
          if (!response.ok) {
            const error = (data as { error?: KitelineError } | null)?.error;
            if (typeof error?.code !== "string" || typeof error.message !== "string")
              throw new Error(`Invalid HTTP ${response.status} error response`);
            if (response.status === 401) host.unauthenticated?.();
            const failure = apiError(error);
            failure.retryable = gatewayStatuses.has(response.status);
            throw failure;
          }
          return data as T;
        },
      );
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
  function post<T>(path: string, value: unknown = {}, signal?: AbortSignal, mutation = true) {
    return api<T>(path, { method: "POST", body: JSON.stringify(value), signal }, mutation);
  }
  function cancelRequest(deviceId: string, requestId: string) {
    return api(
      `/api/devices/${encodeURIComponent(deviceId)}/requests/${encodeURIComponent(requestId)}`,
      { method: "DELETE" },
    );
  }
  function rpcReply<A extends RpcArguments>(
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
  async function rpc<A extends RpcArguments>(
    deviceId: string,
    ...args: A
  ): Promise<RpcResult<A[0]>> {
    const reply = await rpcReply(deviceId, host.newId(), args);
    if (reply.outcome !== "succeeded") throw apiError(reply.error, reply.outcome, reply.result);
    return reply.result;
  }

  return { api, post, cancelRequest, rpcReply, rpc };
}
