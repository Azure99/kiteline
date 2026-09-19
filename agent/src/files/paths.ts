import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { BigIntStats } from "node:fs";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { AppError, string, type Entry } from "@kiteline/shared/protocol";

export function relativePath(value: unknown): string {
  const path = string(value, "path");
  if (isAbsolute(path) || path.split("/").includes(".."))
    throw new AppError("invalid_argument", "A relative path within the workspace is required");
  return normalize(path).replace(/\/$/, "") || ".";
}

export function entryName(value: unknown): string {
  const name = string(value, "name");
  if (name.includes("/") || name === "." || name === "..")
    throw new AppError("invalid_argument", "Enter a single file or directory name");
  return name;
}

export function sameObject(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}

export function versionOf(parent: string, name: string, info: BigIntStats) {
  return createHash("sha256")
    .update(
      [parent, name, info.mode, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(
        "\0",
      ),
    )
    .digest("hex");
}

export async function locate(root: string, path: string) {
  const absolute = join(root, relativePath(path));
  const parent = await realpath(dirname(absolute));
  const name = basename(absolute);
  return {
    parent,
    name,
    absolute: join(parent, name),
    parentInfo: await stat(parent, { bigint: true }),
  };
}

export async function protectRoot(root: string, path: string, info: BigIntStats) {
  if (path === "." || (info.isDirectory() && sameObject(info, await stat(root, { bigint: true }))))
    throw new AppError(
      "invalid_argument",
      "Cannot rename, move, or delete the workspace root directory",
    );
}

export async function readEntry(parent: string, rawName: Buffer, path?: string): Promise<Entry> {
  const absolute = Buffer.concat([
    Buffer.from(parent.endsWith("/") ? parent : parent + "/"),
    rawName,
  ]);
  const info = await lstat(absolute, { bigint: true });
  const name = rawName.toString("utf8");
  return {
    name,
    ...(isUtf8(rawName)
      ? { path: path ?? join(parent, name) }
      : { path: null, unavailableReason: "invalid_utf8" as const }),
    kind: info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other",
    size: Number(info.size),
    mtime: new Date(Number(info.mtimeMs)).toISOString(),
    ...(info.isSymbolicLink() ? { linkTarget: await readlink(absolute) } : {}),
  };
}
