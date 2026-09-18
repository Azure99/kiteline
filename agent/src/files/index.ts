import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppError,
  OperationError,
  limits,
  type FileListing,
  type FileInspection,
} from "@kiteline/shared/protocol";
import type { Directories } from "../directories.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "../mutations.js";
import { entryName, locate, protectRoot, readEntry, relativePath, versionOf } from "./paths.js";
import { renameNoReplace } from "./rename.js";

export class Files {
  constructor(
    private metadata: MetadataStore,
    private directories: Directories,
  ) {}

  async list(
    workspaceId: string,
    input: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<FileListing> {
    const root = this.metadata.workspace(workspaceId).path;
    const path = relativePath(input);
    const result = await this.directories.list(join(root, path), cursor, signal, path);
    return {
      path,
      resolvedPath: result.path,
      entries: result.entries,
    };
  }

  async inspect(
    workspaceId: string,
    input: string,
    suggestCopyName = false,
    signal?: AbortSignal,
  ): Promise<FileInspection> {
    const root = this.metadata.workspace(workspaceId).path;
    const path = relativePath(input);
    const target = await locate(root, path);
    const info = await lstat(target.absolute, { bigint: true });
    const entry = await readEntry(target.parent, Buffer.from(target.name), path);
    const targetVersion = versionOf(target.parent, target.name, info);
    if (!suggestCopyName) return { entry, targetVersion };
    const dot = info.isDirectory() ? -1 : target.name.lastIndexOf(".");
    const stem = dot > 0 ? target.name.slice(0, dot) : target.name;
    const suffix = dot > 0 ? target.name.slice(dot) : "";
    for (let n = 2; n < 2 + limits.copyNameAttempts; n++) {
      signal?.throwIfAborted();
      const suggestedName = `${stem} (${n})${suffix}`;
      try {
        await lstat(join(target.parent, suggestedName));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { entry, targetVersion, suggestedName };
        if (code === "ENAMETOOLONG") break;
        throw error;
      }
    }
    return { entry, targetVersion };
  }

  create(workspaceId: string, input: string, kind: string, signal?: AbortSignal) {
    if (kind !== "file" && kind !== "directory")
      throw new AppError("invalid_argument", "无效文件类型");
    const root = this.metadata.workspace(workspaceId).path;
    const path = relativePath(input);
    if (path === ".") throw new AppError("conflict", "workspace 根目录已经存在");
    return publish(async () => {
      const target = await locate(root, path);
      signal?.throwIfAborted();
      if (kind === "directory") await mkdir(target.absolute);
      else {
        const file = await open(target.absolute, "wx");
        try {
          await file.close();
        } catch (error) {
          throw new OperationError("io_error", String(error), "partial", { path });
        }
      }
      try {
        return await readEntry(target.parent, Buffer.from(target.name), path);
      } catch (error) {
        throw new OperationError("io_error", `已创建，读取结果失败：${String(error)}`, "partial", {
          path,
        });
      }
    }, signal);
  }

  rename(workspaceId: string, input: string, newName: string, signal?: AbortSignal) {
    const root = this.metadata.workspace(workspaceId).path;
    const path = relativePath(input);
    const name = entryName(newName);
    return publish(async () => {
      const source = await locate(root, path);
      const info = await lstat(source.absolute, { bigint: true });
      await protectRoot(root, path, info);
      const to = join(dirname(path), name);
      if (path === to) throw new AppError("invalid_argument", "新名称与原名称相同");
      signal?.throwIfAborted();
      await renameNoReplace(source.absolute, join(source.parent, name));
      return { from: path, to };
    }, signal);
  }
}
