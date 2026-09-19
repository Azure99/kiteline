import { constants } from "node:fs";
import { open, realpath, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { imageSize } from "image-size";
import {
  AppError,
  OperationError,
  type FileMeta,
  type UploadedFile,
} from "@kiteline/shared/protocol";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "../mutations.js";
import { checkTarget, targetAgain } from "./destination.js";
import { locate, relativePath } from "./paths.js";
import { renameNoReplace } from "./rename.js";
import { readExact, type FileRead } from "./text.js";
import type { Temporary, TemporaryFiles } from "./temporary.js";

export interface UploadWrite {
  workspaceId: string;
  path: string;
  size: number;
  received: number;
  target: Awaited<ReturnType<typeof locate>>;
  targetPath: string;
  collision: "error" | "replace";
  expectedTargetVersion?: string;
  temporary: Temporary;
  published: boolean;
  uncertain: boolean;
}

export class BinaryFiles {
  constructor(
    private config: AgentConfig,
    private metadata: MetadataStore,
    private temporary: TemporaryFiles,
  ) {}

  async read(
    workspaceId: string,
    path: string,
    purpose: "image" | "download",
    signal: AbortSignal,
  ): Promise<FileRead> {
    path = relativePath(path);
    const absolute = await realpath(join(this.metadata.workspace(workspaceId).path, path));
    const file = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await file.close();
      }
    };
    try {
      signal.throwIfAborted();
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) throw new AppError("unsupported", "Only regular files can be read");
      const size = Number(info.size);
      const limit =
        purpose === "image" ? this.config.limits.imageBytes : this.config.limits.transferBytes;
      if (!Number.isSafeInteger(size) || size > limit)
        throw new AppError(
          "limit_exceeded",
          purpose === "image"
            ? "Image exceeds the preview size limit"
            : "File exceeds the transfer size limit",
        );
      const meta: FileMeta = {
        size,
        filename: basename(path),
        contentType: "application/octet-stream",
      };
      const check = async () => {
        if (purpose === "download") return;
        const after = await file.stat({ bigint: true });
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs)
          throw new AppError("conflict", "Image changed while being read; try again");
      };
      let bytes: Buffer | undefined;
      if (purpose === "image") {
        bytes = await readExact(file, size, signal);
        let dimensions;
        try {
          dimensions = imageSize(bytes);
        } catch {
          throw new AppError("unsupported", "Image format is corrupt or unsupported");
        }
        const { type, width, height } = dimensions;
        const mime = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[
          type ?? ""
        ];
        if (!mime || !width || !height)
          throw new AppError("unsupported", "Only PNG, JPEG, WebP, and GIF images are supported");
        if (width * height > this.config.limits.imagePixels)
          throw new AppError("limit_exceeded", "Image dimensions exceed the preview limit");
        Object.assign(meta, { contentType: mime, width, height });
        await check();
      }
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
            : readExact(file, length, signal, position),
        finish: size ? finish : async () => {},
        close,
      };
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }

  async prepare(
    workspaceId: string,
    path: string,
    size: number,
    createOnly: boolean,
    expectedTargetVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<UploadWrite> {
    if (size > this.config.limits.transferBytes)
      throw new AppError("limit_exceeded", "File exceeds the transfer size limit");
    if (createOnly ? expectedTargetVersion !== undefined : !expectedTargetVersion)
      throw new AppError("invalid_argument", "Replacement requires the confirmed target version");
    path = relativePath(path);
    const root = this.metadata.workspace(workspaceId).path;
    const collision = createOnly ? "error" : "replace";
    const target = await publish(async () => {
      const location = await locate(root, path);
      await checkTarget(location, { targetPath: path, collision, expectedTargetVersion }, false);
      return location;
    }, signal);
    const temporary = await this.temporary.create(target.parent, target.parentInfo, signal);
    return {
      workspaceId,
      path,
      targetPath: path,
      target,
      size,
      received: 0,
      collision,
      expectedTargetVersion,
      temporary,
      published: false,
      uncertain: false,
    };
  }

  async save(item: UploadWrite, signal: AbortSignal): Promise<UploadedFile> {
    if (item.received !== item.size)
      throw new AppError("invalid_argument", "Received body length is incomplete");
    await item.temporary.handle.chmod(0o666 & ~process.umask());
    await this.temporary.closeFile(item.temporary);
    return publish(async () => {
      await this.temporary.checkLocked(item.temporary);
      const current = await targetAgain(
        this.metadata.workspace(item.workspaceId).path,
        item.path,
        item.target,
      );
      await checkTarget(current, item, false);
      signal.throwIfAborted();
      try {
        if (item.collision === "replace") await rename(item.temporary.path, current.absolute);
        else await renameNoReplace(item.temporary.path, current.absolute);
        item.published = true;
      } catch (error) {
        if (error instanceof OperationError && error.outcome === "unknown") item.uncertain = true;
        throw error;
      }
      try {
        await this.temporary.forgetLocked(item.temporary);
        return { path: item.path, size: item.size };
      } catch (error) {
        throw new OperationError(
          "io_error",
          `Published, but the result is unconfirmed: ${String(error)}`,
          "unknown",
          {
            path: item.path,
            size: item.size,
          },
        );
      }
    }, signal);
  }
}
