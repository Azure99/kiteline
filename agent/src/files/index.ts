import { agentLimits } from "../limits.js";
import { mkdir, open } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  AppError,
  OperationError,
  type FileListing,
  type FileInspection,
} from "@kiteline/shared/protocol";
import type { Directories } from "./directories.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "./publish.js";
import {
  entryInfo,
  entryName,
  locate,
  logicalPath,
  protectRoot,
  readEntry,
  relativePath,
  versionOf,
} from "./paths.js";
import { renameEntry } from "./rename.js";

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
    const path = await logicalPath(root, input, false, signal);
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
    const path = await logicalPath(root, input, false, signal);
    const target = await locate(root, path);
    const info = await entryInfo(target.absolute);
    const entry = await readEntry(target.parent, Buffer.from(target.name), path);
    const targetVersion = versionOf(target.parent, target.name, info);
    if (!suggestCopyName) return { entry, targetVersion };
    const dot = info.isDirectory() ? -1 : target.name.lastIndexOf(".");
    const stem = dot > 0 ? target.name.slice(0, dot) : target.name;
    const suffix = dot > 0 ? target.name.slice(dot) : "";
    for (let n = 2; n < 2 + agentLimits.copyNameAttempts; n++) {
      signal?.throwIfAborted();
      const suggestedName = `${stem} (${n})${suffix}`;
      try {
        await entryInfo(join(target.parent, suggestedName));
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
      throw new AppError("invalid_argument", "Invalid file type");
    const root = this.metadata.workspace(workspaceId).path;
    let path = relativePath(input);
    if (path === ".") throw new AppError("conflict", "Workspace root directory already exists");
    return publish(async () => {
      path = await logicalPath(root, path, true, signal);
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
        throw new OperationError(
          "io_error",
          `Created, but reading the result failed: ${String(error)}`,
          "partial",
          {
            path,
          },
        );
      }
    }, signal);
  }

  rename(workspaceId: string, input: string, newName: string, signal?: AbortSignal) {
    const root = this.metadata.workspace(workspaceId).path;
    const path = relativePath(input);
    const name = entryName(newName);
    return publish(async () => {
      const actual = await logicalPath(root, path, false, signal);
      const source = await locate(root, actual);
      const info = await entryInfo(source.absolute);
      await protectRoot(root, path, info);
      const to = posix.join(posix.dirname(actual), name);
      if (actual === to)
        throw new AppError("invalid_argument", "New name is the same as the original name");
      signal?.throwIfAborted();
      await renameEntry(source.absolute, join(source.parent, name), { replace: false });
      return { from: path, to };
    }, signal);
  }
}
