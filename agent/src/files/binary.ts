import { join } from "node:path";
import {
  AppError,
  OperationError,
  type FileReadPurpose,
  type UploadedFile,
} from "@kiteline/shared/protocol";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "./publish.js";
import { checkTarget, targetAgain } from "./destination.js";
import { locate, logicalPath } from "./paths.js";
import { renameNoReplace, renameReplace } from "./rename.js";
import { readFile } from "./read.js";
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
    purpose: Extract<FileReadPurpose, "image" | "download">,
    signal: AbortSignal,
  ) {
    const root = this.metadata.workspace(workspaceId).path;
    path = await logicalPath(root, path, false, signal);
    const result = await readFile(join(root, path), purpose, this.config.limits, signal);
    result.meta.targetPath = path;
    return result;
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
    const root = this.metadata.workspace(workspaceId).path;
    path = await logicalPath(root, path, createOnly, signal);
    const collision = createOnly ? "error" : "replace";
    const target = await publish(async () => {
      const location = await locate(root, path);
      await checkTarget(location, { targetPath: path, collision, expectedTargetVersion }, false);
      return location;
    }, signal);
    const temporary = await this.temporary.create(target.parent, signal);
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
    return publish(async () => {
      const current = await targetAgain(
        this.metadata.workspace(item.workspaceId).path,
        item.path,
        item.target,
      );
      const target = await checkTarget(current, item, false);
      await item.temporary.handle.chmod(
        target?.isFile() ? Number(target.mode & 0o777n) : 0o666 & ~process.umask(),
      );
      await this.temporary.closeFile(item.temporary);
      signal.throwIfAborted();
      try {
        if (item.collision === "replace")
          await renameReplace(item.temporary.path, current.absolute);
        else await renameNoReplace(item.temporary.path, current.absolute);
        item.published = true;
      } catch (error) {
        if (error instanceof OperationError && error.outcome === "unknown") item.uncertain = true;
        throw error;
      }
      return { path: item.path, size: item.size };
    }, signal);
  }
}
