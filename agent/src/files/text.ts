import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, OperationError, limits, type SavedFile } from "@kiteline/shared/protocol";
import { decodeText } from "@kiteline/shared/text";
import { readFile, readExact, revisionOf, revisionDigest } from "./read.js";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "../mutations.js";
import { locate, readEntry, relativePath, versionOf } from "./paths.js";
import { renameNoReplace } from "./rename.js";
import type { TemporaryFiles, Temporary } from "./temporary.js";

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
  constructor(
    private config: AgentConfig,
    private metadata: MetadataStore,
    private temporary: TemporaryFiles,
  ) {}
  private absolute(workspaceId: string, path: string) {
    return join(this.metadata.workspace(workspaceId).path, relativePath(path));
  }
  read(workspaceId: string, path: string, signal: AbortSignal, purpose: "text" | "open" = "text") {
    return readFile(this.absolute(workspaceId, path), purpose, this.config.limits, signal);
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
      throw new AppError("limit_exceeded", "Content to save exceeds the editing size limit");
    if (createOnly ? expectedRevision !== undefined : !expectedRevision)
      throw new AppError("invalid_argument", "Saving requires the corresponding file revision");
    path = relativePath(path);
    const absolute = this.absolute(workspaceId, path);
    let target: string;
    if (createOnly) {
      const location = await locate(this.metadata.workspace(workspaceId).path, path);
      target = location.absolute;
      try {
        await lstat(target);
        throw new AppError("conflict", "Target already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      try {
        target = await realpath(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new AppError("conflict", "Original file no longer exists; save as a new file");
        throw error;
      }
    }
    const parent = dirname(target);
    const temporary = await this.temporary.create(
      parent,
      await stat(parent, { bigint: true }),
      signal,
      { path: absolute, followFinalLink: !createOnly },
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

  async save(item: TextWrite, signal: AbortSignal): Promise<SavedFile> {
    if (item.received !== item.size)
      throw new AppError("invalid_argument", "Received body length is incomplete");
    const content = await readExact(item.temporary.handle, item.size, signal);
    decodeText(content);
    await this.temporary.closeFile(item.temporary);
    return publish(async () => {
      signal.throwIfAborted();
      await this.temporary.checkLocked(item.temporary);
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
            throw new AppError("conflict", "Original file no longer exists; save as a new file");
          throw error;
        }
        target = current.resolvedPath;
        if (current.revision !== item.expectedRevision) {
          const location = await locate(this.metadata.workspace(item.workspaceId).path, item.path);
          const info = await lstat(location.absolute, { bigint: true });
          throw new AppError("conflict", "Disk content or link target has changed", {
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
      if (target !== item.target) throw new AppError("conflict", "Save target path has changed");
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
      const result = {
        path: item.path,
        size: item.size,
        revision: revisionOf(target, BigInt(item.temporary.dev), content),
      };
      await this.temporary.publishedLocked(item.temporary);
      return result;
    }, signal);
  }

  private async currentVersion(workspaceId: string, path: string, signal: AbortSignal) {
    const resolvedPath = await realpath(this.absolute(workspaceId, path));
    const file = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) throw new AppError("conflict", "Original file type has changed");
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
        if (!bytesRead) throw new AppError("conflict", "File changed during verification");
        hash.update(block.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (after.size !== info.size || after.mtimeNs !== info.mtimeNs)
        throw new AppError("conflict", "File changed during verification");
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
