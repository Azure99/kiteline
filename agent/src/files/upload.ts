import { AppError, type UploadedFile } from "@kiteline/shared/protocol";
import type { AgentConfig } from "../config.js";
import type { MetadataStore } from "../metadata.js";
import { publish } from "./publish.js";
import { checkTarget, targetAgain } from "./destination.js";
import { locate, logicalPath } from "./paths.js";
import { publishTemporary, type Temporary, type TemporaryFiles } from "./temporary.js";

export interface UploadWrite {
  workspaceId: string;
  path: string;
  size: number;
  received: number;
  target: Awaited<ReturnType<typeof locate>>;
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
      const target = await checkTarget(
        current,
        {
          targetPath: item.path,
          collision: item.collision,
          expectedTargetVersion: item.expectedTargetVersion,
        },
        false,
      );
      await item.temporary.handle.chmod(
        target?.isFile() ? Number(target.mode & 0o777n) : 0o666 & ~process.umask(),
      );
      await this.temporary.closeFile(item.temporary);
      signal.throwIfAborted();
      await publishTemporary(item, current.absolute, item.collision === "replace");
      return { path: item.path, size: item.size };
    }, signal);
  }
}
