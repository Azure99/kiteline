import { fileDownloadPath, versionedPath } from "@kiteline/shared/protocol/client";
import type {
  KitelineError,
  FileMeta,
  FileReadPurpose,
  FileTarget,
  Reply,
  SavedFile,
  UploadedFile,
} from "@kiteline/shared/protocol";
import { decodeText } from "@kiteline/shared/protocol/text";
import { ApiError, api, apiError, fileChannel, request } from "../lib/api";
import { observeServerVersion, webCompatible } from "../lib/release";

export type { FileTarget } from "@kiteline/shared/protocol";
export interface DiskText {
  target: FileTarget;
  meta: FileMeta;
  text: string;
  raw: string;
}
export interface DiskImage {
  blob: Blob;
  meta: FileMeta;
}
async function release(id: string) {
  await api(`/api/channels/${id}`, { method: "DELETE" }).catch(() => {});
}
async function readContentBytes(
  target: FileTarget,
  purpose: Extract<FileReadPurpose, "open" | "text">,
  signal: AbortSignal,
  onChannel?: (id: string) => void,
) {
  const ready = await fileChannel(target, "file.read", { purpose }, signal);
  onChannel?.(ready.channelId);
  try {
    const bytes = await request(
      `/api/channels/${ready.channelId}/content`,
      { signal },
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
    if (bytes.length !== ready.meta.size) throw new Error("File transfer is incomplete");
    return { bytes, meta: ready.meta };
  } finally {
    void release(ready.channelId);
  }
}
function diskText(target: FileTarget, bytes: Uint8Array, meta: FileMeta): DiskText {
  return {
    target: { ...target, path: meta.targetPath! },
    meta,
    text: decodeText(bytes).text,
    raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  };
}
export async function readText(
  target: FileTarget,
  signal: AbortSignal,
  onChannel?: (id: string) => void,
) {
  const { bytes, meta } = await readContentBytes(target, "text", signal, onChannel);
  return diskText(target, bytes, meta);
}
export async function readContent(
  target: FileTarget,
  signal: AbortSignal,
  onChannel: (id: string) => void,
): Promise<{ kind: "text"; value: DiskText } | { kind: "image"; value: DiskImage }> {
  const { bytes, meta } = await readContentBytes(target, "open", signal, onChannel);
  return meta.contentType.startsWith("image/")
    ? { kind: "image", value: { blob: new Blob([bytes], { type: meta.contentType }), meta } }
    : { kind: "text", value: diskText(target, bytes, meta) };
}
export async function writeText(
  target: FileTarget,
  bytes: Uint8Array,
  expectedRevision: string | undefined,
  signal: AbortSignal,
  prepared: (path: string) => void,
): Promise<SavedFile> {
  const ready = await fileChannel(
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
    prepared(ready.meta.targetPath!);
    const reply = await api<Reply<SavedFile>>(`/api/channels/${ready.channelId}/content`, {
      method: "PUT",
      body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
      headers: { "content-type": "application/octet-stream" },
      signal,
    });
    if (reply.outcome !== "succeeded") throw apiError(reply.error, reply.outcome, reply.result);
    return reply.result;
  } finally {
    void release(ready.channelId);
  }
}

export function downloadFile(target: FileTarget) {
  if (!webCompatible()) return;
  const link = document.createElement("a");
  link.href = versionedPath(fileDownloadPath(target));
  link.download = target.path.split("/").at(-1)!;
  document.body.append(link);
  link.click();
  link.remove();
}

export async function uploadFile(
  target: FileTarget,
  file: File,
  version: string | undefined,
  signal: AbortSignal,
  onProgress: (sent: number) => void,
  onReady: (cancel: () => Promise<unknown>) => void,
): Promise<UploadedFile> {
  const ready = await fileChannel(
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
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
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
        else if (
          cancelled &&
          request.status === 404 &&
          reply &&
          "error" in reply &&
          reply.error.code === "not_found"
        )
          reject(new ApiError("cancelled", "Upload cancelled", "failed"));
        else if (reply && "error" in reply)
          reject(
            apiError(
              reply.error,
              "outcome" in reply ? reply.outcome : undefined,
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
      onReady(() => {
        cancelled = true;
        return api(`/api/channels/${ready.channelId}`, { method: "DELETE" });
      });
      if (signal.aborted) cancel();
    });
  } finally {
    void release(ready.channelId);
  }
}
