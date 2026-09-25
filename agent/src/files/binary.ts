import { rename } from "node:fs/promises";
import { join } from "node:path";
import { AppError, OperationError, type UploadedFile } from "@kiteline/shared/protocol";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "../mutations.js";
import { checkTarget, targetAgain } from "./destination.js";
import { locate, relativePath } from "./paths.js";
import { renameNoReplace } from "./rename.js";
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

  read(workspaceId: string, path: string, purpose: "image" | "download", signal: AbortSignal) {
    return readFile(
      join(this.metadata.workspace(workspaceId).path, relativePath(path)),
      purpose,
      this.config.limits,
      signal,
    );
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
