import {
  appVersion,
  rpcTraits,
  type KitelineError,
  type ChannelParams,
  type ChannelReady,
  type FileMeta,
  type FileReadPurpose,
  type FileTarget,
  type Outcome,
  type RpcArguments,
  type RpcReply,
  type RpcResult,
  type TerminalMeta,
} from "./index.js";

export class ApiError extends Error {
  retryable = false;
  constructor(
    public code: string,
    message: string,
    public outcome?: Outcome,
    public details?: unknown,
    public result?: unknown,
  ) {
    super(message);
  }
}
export function apiError(error: KitelineError, outcome?: Outcome, result?: unknown) {
  return new ApiError(error.code, error.message, outcome, error.details, result);
}
const gatewayStatuses = new Set([502, 503, 504]);
type ResponseLoss = (typeof rpcTraits)[keyof typeof rpcTraits]["responseLoss"];
type PublicChannelParams = Omit<ChannelParams, "http.proxy" | "file.read"> & {
  "file.read": ChannelParams["file.read"] & {
    purpose: Exclude<FileReadPurpose, "download">;
  };
};
type ContentParams<T> = T extends unknown ? Omit<T, "workspaceId" | "path"> : never;

export function fileDownloadPath(target: FileTarget) {
  return `/api/devices/${encodeURIComponent(target.deviceId)}/download?${new URLSearchParams({ workspaceId: target.workspaceId, path: target.path })}`;
}

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
  async function request<T>(
    path: string,
    options: RequestInit,
    consume: (response: Response) => Promise<T>,
    responseLoss: ResponseLoss = !!options.method && !["GET", "HEAD"].includes(options.method)
      ? "unknown"
      : "read-error",
  ): Promise<T> {
    let response: Response | undefined;
    try {
      return await host.request(versionedPath(path), options, async (received) => {
        response = received;
        host.observeServerVersion?.(response.headers.get("x-kiteline-version"));
        if (!response.ok) {
          const data: unknown = await response.json();
          const error = (data as { error?: KitelineError } | null)?.error;
          if (typeof error?.code !== "string" || typeof error.message !== "string")
            throw new Error(`Invalid HTTP ${response.status} error response`);
          if (response.status === 401) host.unauthenticated?.();
          const failure = apiError(error);
          failure.retryable = gatewayStatuses.has(response.status);
          throw failure;
        }
        return consume(response);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (responseLoss === "unknown")
        throw new ApiError("io_error", "No operation result was received", "unknown");
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
  function api<T>(
    path: string,
    options: RequestInit = {},
    responseLoss?: ResponseLoss,
  ): Promise<T> {
    return request(
      path,
      {
        ...options,
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
      },
      (response) => response.json() as Promise<T>,
      responseLoss,
    );
  }
  function post<T>(
    path: string,
    value: unknown = {},
    signal?: AbortSignal,
    responseLoss?: ResponseLoss,
  ) {
    return api<T>(path, { method: "POST", body: JSON.stringify(value), signal }, responseLoss);
  }
  function cancelRequest(deviceId: string, requestId: string) {
    return api(
      `/api/devices/${encodeURIComponent(deviceId)}/requests/${encodeURIComponent(requestId)}`,
      { method: "DELETE" },
    );
  }
  function openChannel<K extends keyof PublicChannelParams>(
    deviceId: string,
    kind: K,
    params: PublicChannelParams[K],
    signal?: AbortSignal,
  ): Promise<ChannelReady<K extends "terminal.attach" ? TerminalMeta : FileMeta>> {
    return post(
      `/api/devices/${encodeURIComponent(deviceId)}/channels`,
      { kind, params },
      signal,
      "read-error",
    );
  }
  function cancelChannel(channelId: string) {
    return api<{ found: boolean }>(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: "DELETE",
    });
  }
  async function fileChannel<K extends "file.read" | "file.write">(
    target: FileTarget,
    kind: K,
    params: ContentParams<PublicChannelParams[K]>,
    signal?: AbortSignal,
  ) {
    const channelParams: PublicChannelParams["file.read" | "file.write"] = {
      workspaceId: target.workspaceId,
      path: target.path,
      ...params,
    };
    const ready = await openChannel(
      target.deviceId,
      kind,
      channelParams as PublicChannelParams[K],
      signal,
    );
    if (signal?.aborted) {
      void cancelChannel(ready.channelId).catch(() => {});
      throw new DOMException("The operation was aborted", "AbortError");
    }
    return ready;
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
      rpcTraits[method].responseLoss,
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

  return {
    request,
    api,
    post,
    openChannel,
    cancelChannel,
    fileChannel,
    cancelRequest,
    rpcReply,
    rpc,
  };
}
