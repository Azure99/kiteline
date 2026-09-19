import type {
  ChannelReady,
  KitelineError,
  FileMeta,
  Reply,
  SavedFile,
  UploadedFile,
} from "@kiteline/shared/protocol";
import { decodeText } from "@kiteline/shared/text";
import { ApiError, api, post } from "../lib/api";
import { observeServerVersion, versionedPath, webCompatible } from "../lib/release";

export interface FileTarget {
  deviceId: string;
  workspaceId: string;
  path: string;
}
export interface DiskText {
  target: FileTarget;
  meta: FileMeta;
  text: string;
  raw: string;
}
async function channel(target: FileTarget, kind: string, params: object, signal: AbortSignal) {
  const ready = await post<ChannelReady<FileMeta>>(
    `/api/devices/${encodeURIComponent(target.deviceId)}/channels`,
    { kind, params: { workspaceId: target.workspaceId, path: target.path, ...params } },
    signal,
    false,
  );
  if (signal.aborted) {
    void release(ready.channelId);
    signal.throwIfAborted();
  }
  return ready;
}
async function release(id: string) {
  await api(`/api/channels/${id}`, { method: "DELETE" }).catch(() => {});
}
async function check(response: Response) {
  observeServerVersion(response.headers.get("x-kiteline-version"));
  if (response.ok) return;
  if (response.status === 401) window.dispatchEvent(new Event("kiteline:unauthenticated"));
  const data = (await response.json()) as { error: KitelineError };
  throw new ApiError(data.error.code, data.error.message, undefined, data.error.details);
}
export async function readText(
  target: FileTarget,
  signal: AbortSignal,
  onChannel?: (id: string) => void,
): Promise<DiskText> {
  const ready = await channel(target, "file.read", { purpose: "text" }, signal);
  onChannel?.(ready.channelId);
  try {
    const response = await fetch(versionedPath(`/api/channels/${ready.channelId}/content`), {
      signal,
    });
    await check(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== ready.meta.size) throw new Error("File transfer is incomplete");
    return {
      target,
      meta: ready.meta,
      text: decodeText(bytes).text,
      raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } finally {
    void release(ready.channelId);
  }
}
export async function writeText(
  target: FileTarget,
  bytes: Uint8Array,
  expectedRevision: string | undefined,
  signal: AbortSignal,
): Promise<SavedFile> {
  const ready = await channel(
    target,
    "file.write",
    {
      purpose: "save",
      size: bytes.length,
      expectedRevision,
      createOnly: expectedRevision === undefined,
    },
    signal,
  );
  try {
    const response = await fetch(versionedPath(`/api/channels/${ready.channelId}/content`), {
      method: "PUT",
      body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
      signal,
    });
    await check(response);
    const reply = (await response.json()) as Reply<SavedFile>;
    if (reply.outcome !== "succeeded")
      throw new ApiError(
        reply.error.code,
        reply.error.message,
        reply.outcome,
        reply.error.details,
        reply.result,
      );
    return reply.result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("io_error", "The save result is unconfirmed", "unknown");
  } finally {
    void release(ready.channelId);
  }
}

export function downloadFile(target: FileTarget) {
  if (!webCompatible()) return;
  const link = document.createElement("a");
  link.href = versionedPath(
    `/api/devices/${encodeURIComponent(target.deviceId)}/download?${new URLSearchParams({ workspaceId: target.workspaceId, path: target.path })}`,
  );
  link.download = target.path.split("/").at(-1)!;
  document.body.append(link);
  link.click();
  link.remove();
  window.dispatchEvent(new CustomEvent("kiteline:download", { detail: target }));
}

export async function readImage(
  target: FileTarget,
  signal: AbortSignal,
  onChannel: (id: string) => void,
) {
  const ready = await channel(target, "file.read", { purpose: "image" }, signal);
  onChannel(ready.channelId);
  try {
    const response = await fetch(versionedPath(`/api/channels/${ready.channelId}/content`), {
      signal,
    });
    await check(response);
    const blob = await response.blob();
    if (blob.size !== ready.meta.size) throw new Error("Image transfer is incomplete");
    return { blob, meta: ready.meta };
  } finally {
    void release(ready.channelId);
  }
}

export async function uploadFile(
  target: FileTarget,
  file: File,
  version: string | undefined,
  signal: AbortSignal,
  onProgress: (sent: number) => void,
): Promise<UploadedFile> {
  const ready = await channel(
    target,
    "file.write",
    {
      purpose: "upload",
      size: file.size,
      createOnly: version === undefined,
      expectedTargetVersion: version,
    },
    signal,
  );
  try {
    return await new Promise<UploadedFile>((resolve, reject) => {
      const request = new XMLHttpRequest();
      const cancel = () => {
        void release(ready.channelId);
      };
      signal.addEventListener("abort", cancel, { once: true });
      const cleanup = () => signal.removeEventListener("abort", cancel);
      request.open("PUT", versionedPath(`/api/channels/${ready.channelId}/content`));
      request.responseType = "json";
      request.upload.onprogress = (event) => onProgress(event.loaded);
      request.onload = () => {
        cleanup();
        observeServerVersion(request.getResponseHeader("x-kiteline-version"));
        if (request.status === 401) window.dispatchEvent(new Event("kiteline:unauthenticated"));
        const reply = request.response as Reply<UploadedFile> | { error: KitelineError } | null;
        if (reply && "outcome" in reply && reply.outcome === "succeeded") resolve(reply.result);
        else if (reply && "error" in reply)
          reject(
            new ApiError(
              reply.error.code,
              reply.error.message,
              "outcome" in reply ? reply.outcome : undefined,
              reply.error.details,
              "result" in reply ? reply.result : undefined,
            ),
          );
        else reject(new ApiError("io_error", "The upload result is unconfirmed", "unknown"));
      };
      request.onerror = () => {
        cleanup();
        reject(new ApiError("io_error", "The upload result is unconfirmed", "unknown"));
      };
      request.send(file);
      if (signal.aborted) cancel();
    });
  } finally {
    void release(ready.channelId);
  }
}
