import { AppError, type UploadedFile } from "@kiteline/shared/protocol";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { withPublicationLock } from "./publish.js";
import { checkTarget, targetAgain } from "./destination.js";
import { locate, logicalPath } from "./paths.js";
import type { StagedFile, TemporaryFiles } from "./temporary.js";

export interface UploadWrite {
  workspaceId: string;
  path: string;
  size: number;
  target: Awaited<ReturnType<typeof locate>>;
  collision: "error" | "replace";
  expectedTargetVersion?: string;
  temporary: StagedFile;
}

export class BinaryFiles {
  constructor(
    private config: AgentConfig,
    private metadata: MetadataStore,
    private temporary: TemporaryFiles,
  ) {}

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
    const target = await withPublicationLock(async () => {
      const location = await locate(root, path);
      await checkTarget(location, { targetPath: path, collision, expectedTargetVersion }, false);
      return location;
    }, signal);
    const temporary = await this.temporary.create(target.parent, signal);
    return {
      workspaceId,
      path,
      target,
      size,
      collision,
      expectedTargetVersion,
      temporary,
    };
  }

  async save(item: UploadWrite, signal: AbortSignal): Promise<UploadedFile> {
    if (item.temporary.bytesWritten !== item.size)
      throw new AppError("invalid_argument", "Received body length is incomplete");
    return withPublicationLock(async () => {
      const current = await targetAgain(
        this.metadata.workspace(item.workspaceId).path,
        item.path,
        item.target,
      );
      const target = await checkTarget(
        current,
        {
          targetPath: item.path,
          collision: item.collision,
          expectedTargetVersion: item.expectedTargetVersion,
        },
        false,
      );
      await item.temporary.seal(
        target?.isFile() ? Number(target.mode & 0o777n) : 0o666 & ~process.umask(),
      );
      signal.throwIfAborted();
      await item.temporary.publish(current.absolute, { replace: item.collision === "replace" });
      return { path: item.path, size: item.size };
    }, signal);
  }
}
