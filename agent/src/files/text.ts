import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  AppError,
  OperationError,
  limits,
  type FileMeta,
  type SavedFile,
} from "@kiteline/shared/protocol";
import { decodeText, encodeText } from "@kiteline/shared/text";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "../mutations.js";
import { locate, readEntry, relativePath, versionOf } from "./paths.js";
import { renameNoReplace } from "./rename.js";
import { TemporaryFiles, type Temporary } from "./temporary.js";

export interface FileRead {
  meta: FileMeta;
  read: (position: number, size: number) => Promise<Buffer>;
  close: () => Promise<void>;
  finish: () => Promise<void>;
}
export interface TextRead extends FileRead {
  bytes: Buffer;
  info: BigIntStats;
}
export interface TextWrite {
  path: string;
  workspaceId: string;
  size: number;
  received: number;
  expectedRevision?: string;
  createOnly: boolean;
  target: string;
  temporary: Temporary;
  published: boolean;
  uncertain: boolean;
}

export class TextFiles {
  readonly temporary: TemporaryFiles;
  constructor(
    private config: AgentConfig,
    private metadata: MetadataStore,
  ) {
    this.temporary = new TemporaryFiles(config.dataDir);
  }
  private absolute(workspaceId: string, path: string) {
    return join(this.metadata.workspace(workspaceId).path, relativePath(path));
  }
  async read(workspaceId: string, path: string, signal: AbortSignal): Promise<TextRead> {
    const resolvedPath = await realpath(this.absolute(workspaceId, path));
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
      if (!info.isFile()) throw new AppError("unsupported", "只支持编辑普通文本文件");
      const size = Number(info.size);
      if (size > this.config.limits.editorBytes)
        throw new AppError("limit_exceeded", "文件超过文本编辑容量");
      const bytes = await readExact(handle, size, signal);
      const { text, format } = decodeText(bytes);
      if (encodeText(text, format).length > this.config.limits.editorBytes)
        throw new AppError("limit_exceeded", "按保存换行格式编码后超过编辑容量");
      const check = async () => {
        const after = await handle.stat({ bigint: true });
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs)
          throw new AppError("conflict", "读取期间文件已变化，请重试");
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
        bytes,
        info,
        read: async (position, size) => bytes.subarray(position, position + size),
        close,
        finish: size ? finish : async () => {},
        meta: {
          size,
          filename: basename(path),
          contentType: "text/plain; charset=utf-8",
          resolvedPath,
          mode: Number(info.mode & 0o777n),
          revision: revisionOf(resolvedPath, info.dev, bytes),
          ...format,
        },
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
    expectedRevision: string | undefined,
    signal: AbortSignal,
  ): Promise<TextWrite> {
    if (size > this.config.limits.editorBytes)
      throw new AppError("limit_exceeded", "保存内容超过编辑容量");
    if (createOnly ? expectedRevision !== undefined : !expectedRevision)
      throw new AppError("invalid_argument", "保存需要对应的文件版本");
    path = relativePath(path);
    const absolute = this.absolute(workspaceId, path);
    let target: string;
    if (createOnly) {
      const location = await locate(this.metadata.workspace(workspaceId).path, path);
      target = location.absolute;
      try {
        await lstat(target);
        throw new AppError("conflict", "目标已经存在");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      try {
        target = await realpath(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new AppError("conflict", "原文件已不存在，请另存");
        throw error;
      }
    }
    const parent = dirname(target);
    const temporary = await this.temporary.create(
      parent,
      await stat(parent, { bigint: true }),
      signal,
    );
    return {
      workspaceId,
      path,
      size,
      received: 0,
      expectedRevision,
      createOnly,
      target,
      temporary,
      published: false,
      uncertain: false,
    };
  }

  async write(
    item: Pick<TextWrite, "size" | "received" | "temporary">,
    bytes: Buffer,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (item.received + bytes.length > item.size)
      throw new AppError("invalid_argument", "收到的正文超过声明长度");
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const result = await item.temporary.handle.write(
        bytes,
        offset,
        bytes.length - offset,
        item.received + offset,
      );
      if (!result.bytesWritten) throw new AppError("io_error", "文件写入未能继续");
      offset += result.bytesWritten;
    }
    item.received += bytes.length;
  }

  async save(item: TextWrite, signal: AbortSignal): Promise<SavedFile> {
    if (item.received !== item.size) throw new AppError("invalid_argument", "收到的正文长度不完整");
    const content = await readExact(item.temporary.handle, item.size, signal);
    decodeText(content);
    await this.temporary.closeFile(item.temporary);
    return publish(async () => {
      signal.throwIfAborted();
      await this.temporary.checkLocked(item.temporary);
      const absolute = this.absolute(item.workspaceId, item.path);
      let target: string;
      let mode = 0o666 & ~process.umask();
      if (item.createOnly) {
        target = (await locate(this.metadata.workspace(item.workspaceId).path, item.path)).absolute;
      } else {
        let current: { resolvedPath: string; mode: number; revision: string };
        try {
          current = await this.currentVersion(item.workspaceId, item.path, signal);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error instanceof AppError && error.code === "not_found")
          )
            throw new AppError("conflict", "原文件已不存在，请另存");
          throw error;
        }
        target = current.resolvedPath;
        if (current.revision !== item.expectedRevision) {
          const location = await locate(this.metadata.workspace(item.workspaceId).path, item.path);
          const info = await lstat(location.absolute, { bigint: true });
          throw new AppError("conflict", "磁盘内容或链接目标已变化", {
            path: item.path,
            current: {
              entry: await readEntry(location.parent, Buffer.from(location.name), item.path),
              targetVersion: versionOf(location.parent, location.name, info),
              revision: current.revision,
            },
          });
        }
        mode = current.mode;
      }
      if (target !== item.target) throw new AppError("conflict", "保存目标路径已变化");
      const prepared = await open(item.temporary.path, "r+");
      try {
        await prepared.chmod(mode);
      } finally {
        await prepared.close();
      }
      signal.throwIfAborted();
      try {
        if (item.createOnly) await renameNoReplace(item.temporary.path, target);
        else await rename(item.temporary.path, target);
        item.published = true;
      } catch (error) {
        if (error instanceof OperationError && error.outcome === "unknown") item.uncertain = true;
        throw error;
      }
      try {
        const published = await stat(target, { bigint: true });
        const location = await locate(this.metadata.workspace(item.workspaceId).path, item.path);
        const finalEntry = await lstat(absolute, { bigint: true });
        const result = {
          path: item.path,
          size: item.size,
          revision: revisionOf(target, published.dev, content),
          targetVersion: versionOf(location.parent, location.name, finalEntry),
        };
        await this.temporary.forgetLocked(item.temporary);
        return result;
      } catch (error) {
        throw new OperationError("io_error", `已发布，结果未确认：${String(error)}`, "unknown", {
          path: item.path,
          size: item.size,
        });
      }
    }, signal);
  }

  async cleanup(item: Pick<TextWrite, "temporary" | "published" | "uncertain">) {
    await this.temporary.closeFile(item.temporary);
    if (!item.published && !item.uncertain) await this.temporary.discard(item.temporary);
  }
  private async currentVersion(workspaceId: string, path: string, signal: AbortSignal) {
    const resolvedPath = await realpath(this.absolute(workspaceId, path));
    const file = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) throw new AppError("conflict", "原文件类型已变化");
      const hash = createHash("sha256");
      const block = Buffer.alloc(limits.dataChunkBytes);
      const size = Number(info.size);
      let offset = 0;
      while (offset < size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          block,
          0,
          Math.min(block.length, size - offset),
          offset,
        );
        if (!bytesRead) throw new AppError("conflict", "校验期间文件已变化");
        hash.update(block.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (after.size !== info.size || after.mtimeNs !== info.mtimeNs)
        throw new AppError("conflict", "校验期间文件已变化");
      return {
        resolvedPath,
        mode: Number(info.mode & 0o777n),
        revision: revisionDigest(resolvedPath, info.dev, hash.digest()),
      };
    } finally {
      await file.close();
    }
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
    if (!bytesRead) throw new AppError("io_error", "文件读取不完整");
    offset += bytesRead;
  }
  return result;
}
function revisionOf(path: string, dev: bigint, content: Buffer) {
  return revisionDigest(path, dev, createHash("sha256").update(content).digest());
}
function revisionDigest(path: string, dev: bigint, digest: Buffer) {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(String(dev))
    .update("\0")
    .update(digest)
    .digest("hex");
}
