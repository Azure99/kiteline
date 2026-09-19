import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { AppError, type CopyItem } from "@kiteline/shared/protocol";
import { locate, readEntry, sameObject, versionOf } from "./paths.js";

export async function targetAgain(
  root: string,
  path: string,
  expected: Awaited<ReturnType<typeof locate>>,
) {
  const current = await locate(root, path);
  if (current.parent !== expected.parent || !sameObject(current.parentInfo, expected.parentInfo))
    throw new AppError("conflict", "Target parent directory has changed");
  return current;
}

export async function checkTarget(
  target: Awaited<ReturnType<typeof locate>>,
  item: Pick<CopyItem, "targetPath" | "collision" | "expectedTargetVersion">,
  directory: boolean,
) {
  let info: BigIntStats;
  try {
    info = await lstat(target.absolute, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (item.collision === "replace")
      throw new AppError("conflict", "The confirmed target no longer exists", {
        path: item.targetPath,
      });
    return;
  }
  const targetVersion = versionOf(target.parent, target.name, info);
  if (
    item.collision !== "replace" ||
    directory ||
    info.isDirectory() ||
    targetVersion !== item.expectedTargetVersion
  )
    throw new AppError(
      "conflict",
      info.isDirectory() || directory
        ? "Directories cannot be replaced or merged"
        : "Target already exists or has changed",
      {
        path: item.targetPath,
        current: {
          entry: await readEntry(target.parent, Buffer.from(target.name), item.targetPath),
          targetVersion,
        },
      },
    );
  return info;
}
