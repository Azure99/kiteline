import type { KitelineError, Reply } from "@kiteline/shared/protocol";

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
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = (data as { error: KitelineError }).error;
      if (response.status === 401) window.dispatchEvent(new Event("kiteline:unauthenticated"));
      throw new ApiError(error.code, error.message, undefined, error.details);
    }
    return data as T;
  } catch (error) {
    if (!mutation || error instanceof ApiError) throw error;
    throw new ApiError("io_error", "未收到操作结果", "unknown");
  }
}
export function post<T>(path: string, value: unknown = {}, signal?: AbortSignal, mutation = true) {
  return api<T>(path, { method: "POST", body: JSON.stringify(value), signal }, mutation);
}
export async function rpc<T>(
  deviceId: string,
  method: string,
  params: object,
  signal?: AbortSignal,
): Promise<T> {
  const reply = await post<Reply<T>>(
    `/api/devices/${encodeURIComponent(deviceId)}/rpc`,
    { id: crypto.randomUUID(), method, params },
    signal,
    !["directories.list", "sessions.list", "files.list", "files.inspect", "files.search"].includes(
      method,
    ),
  );
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
export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof ApiError && error.outcome === "unknown"
    ? `${message}；请刷新确认，勿重复执行。`
    : message;
}
