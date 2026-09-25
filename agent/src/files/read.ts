import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { imageSize } from "image-size";
import { PNG } from "image-size/types/png";
import { JPG } from "image-size/types/jpg";
import { GIF } from "image-size/types/gif";
import { WEBP } from "image-size/types/webp";
import { AppError, limits, type FileMeta } from "@kiteline/shared/protocol";
import { decodeText, encodeText } from "@kiteline/shared/text";
import type { AgentConfig } from "../config.js";

export interface FileRead {
  meta: FileMeta;
  read(position: number, size: number): Promise<Buffer>;
  close(): Promise<void>;
  finish(): Promise<void>;
}

export async function readFile(
  path: string,
  purpose: "open" | "text" | "image" | "download",
  capacity: AgentConfig["limits"],
  signal: AbortSignal,
): Promise<FileRead> {
  const resolvedPath = await realpath(path);
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  try {
    signal.throwIfAborted();
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new AppError("unsupported", "Only regular files can be read");
    const size = Number(info.size);
    if (!Number.isSafeInteger(size)) throw new AppError("limit_exceeded", "File is too large");
    if (purpose === "open") {
      const header = await readExact(handle, Math.min(size, 32), signal);
      try {
        purpose = [PNG, JPG, GIF, WEBP].some((type) => type.validate(header)) ? "image" : "text";
      } catch {
        throw new AppError("unsupported", "Image format is corrupt or unsupported");
      }
    }
    const limit =
      purpose === "text"
        ? capacity.editorBytes
        : purpose === "image"
          ? capacity.imageBytes
          : capacity.transferBytes;
    if (size > limit)
      throw new AppError(
        "limit_exceeded",
        purpose === "text"
          ? "File exceeds the text editing size limit"
          : purpose === "image"
            ? "Image exceeds the preview size limit"
            : "File exceeds the transfer size limit",
      );
    const meta: FileMeta = {
      size,
      filename: basename(path),
      contentType: "application/octet-stream",
    };
    const bytes = purpose === "download" ? undefined : await readExact(handle, size, signal);
    if (purpose === "text") {
      const { text, format } = decodeText(bytes!);
      if (encodeText(text, format).length > capacity.editorBytes)
        throw new AppError(
          "limit_exceeded",
          "Content encoded with the saved line ending format exceeds the editing size limit",
        );
      Object.assign(meta, {
        contentType: "text/plain; charset=utf-8",
        resolvedPath,
        mode: Number(info.mode & 0o777n),
        revision: revisionOf(resolvedPath, info.dev, bytes!),
        ...format,
      });
    } else if (purpose === "image") {
      let dimensions;
      try {
        dimensions = imageSize(bytes!);
      } catch {
        throw new AppError("unsupported", "Image format is corrupt or unsupported");
      }
      const { type, width, height } = dimensions;
      const mime = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[
        type ?? ""
      ];
      if (!mime || !width || !height)
        throw new AppError("unsupported", "Only PNG, JPEG, WebP, and GIF images are supported");
      if (width * height > capacity.imagePixels)
        throw new AppError("limit_exceeded", "Image dimensions exceed the preview limit");
      Object.assign(meta, { contentType: mime, width, height });
    }
    const check = async () => {
      if (purpose === "download") return;
      const after = await handle.stat({ bigint: true });
      if (after.size !== info.size || after.mtimeNs !== info.mtimeNs)
        throw new AppError("conflict", "File changed while being read; try again");
    };
    await check();
    const finish = async () => {
      try {
        signal.throwIfAborted();
        await check();
      } finally {
        await close();
      }
    };
    if (!size) await finish();
    return {
      meta,
      read: async (position, length) =>
        bytes
          ? bytes.subarray(position, position + length)
          : readExact(handle, length, signal, position),
      finish: size ? finish : async () => {},
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export async function readExact(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
  position = 0,
) {
  const result = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      result,
      offset,
      Math.min(size - offset, limits.dataChunkBytes),
      position + offset,
    );
    if (!bytesRead) throw new AppError("io_error", "File read is incomplete");
    offset += bytesRead;
  }
  return result;
}
export function revisionOf(path: string, dev: bigint, content: Buffer) {
  return revisionDigest(path, dev, createHash("sha256").update(content).digest());
}
export function revisionDigest(path: string, dev: bigint, digest: Buffer) {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(String(dev))
    .update("\0")
    .update(digest)
    .digest("hex");
}
