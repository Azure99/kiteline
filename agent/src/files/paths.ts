import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { getSystemErrorName, promisify } from "node:util";
import type { BigIntStats } from "node:fs";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import { AppError, absolutePath, string, windowsName, type Entry } from "@kiteline/shared/protocol";
import { windowsNative } from "@kiteline/shared/windows/native";

export function relativePath(value: unknown): string {
  const path = string(value, "path");
  if (posix.isAbsolute(path) || path.split("/").includes(".."))
    throw new AppError("invalid_argument", "A relative path within the workspace is required");
  if (process.platform === "win32")
    for (const part of path.split("/")) if (part && part !== ".") windowsName(part);
  return posix.normalize(path).replace(/\/$/, "") || ".";
}

export function entryName(value: unknown): string {
  const name = string(value, "name");
  if (name.includes("/") || name === "." || name === "..")
    throw new AppError("invalid_argument", "Enter a single file or directory name");
  if (process.platform === "win32") windowsName(name);
  return name;
}

const nameHelper = resolve(import.meta.dirname, "../../../dist/native/bin/entry-name");

async function storedName(path: string, signal?: AbortSignal) {
  let output: Buffer;
  try {
    ({ stdout: output } = await promisify(execFile)(nameHelper, [path], {
      encoding: "buffer",
      maxBuffer: 4096,
      signal,
    }));
  } catch (error) {
    const result = error as { code?: number; stderr?: Buffer };
    if (result.code === 1 && /^\d+\n$/.test(String(result.stderr))) {
      const code = getSystemErrorName(-Number(String(result.stderr).trim()));
      throw Object.assign(new Error(`${code}: ${path}`), { code });
    }
    throw error;
  }
  if (!isUtf8(output)) throw new AppError("unsupported", "Name is not valid UTF-8");
  return entryName(output.toString());
}

// Resolve spelling only at request boundaries; traversal already supplies stored names.
export async function logicalPath(
  root: string,
  input: string,
  newLeaf = false,
  signal?: AbortSignal,
) {
  const path = relativePath(input);
  if (process.platform !== "darwin" || path === ".") return path;
  const parts = path.split("/");
  let current = ".";
  for (const [index, part] of parts.entries()) {
    signal?.throwIfAborted();
    let name = part;
    if (!newLeaf || index < parts.length - 1) {
      try {
        name = await storedName(join(root, current, part), signal);
      } catch (error) {
        // The caller owns missing-leaf semantics (read, create, or confirmed replacement).
        if (index < parts.length - 1 || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
    }
    current = posix.join(current, name);
  }
  return current;
}

export async function gitMetadataPath(root: string, path: string) {
  if (process.platform !== "darwin") return false;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    if (part.toLowerCase() !== ".git") continue;
    const parent = join(root, ...parts.slice(0, index));
    try {
      if (
        sameObject(
          await lstat(join(parent, part), { bigint: true }),
          await lstat(join(parent, ".git"), { bigint: true }),
        )
      )
        return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

export function devicePath(value: unknown) {
  return absolutePath(
    value,
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  );
}

export async function linkType(path: string | Buffer) {
  if (process.platform !== "win32") return;
  const { attributes, tag } = await windowsNative().fileAttributes(toNamespacedPath(String(path)));
  if (!(attributes & 0x400)) return;
  if (tag === 0xa0000003) return "junction";
  if (tag === 0xa000000c) return attributes & 0x10 ? "dir" : "file";
  throw new AppError("unsupported", `Unsupported Windows reparse point: ${String(path)}`);
}

export async function entryInfo(path: string | Buffer) {
  await linkType(path);
  return lstat(path, { bigint: true });
}

async function windowsRealPath(path: string) {
  path = path.replaceAll("/", "\\");
  let current = parse(path).root;
  const remaining = path.slice(current.length).split(sep).filter(Boolean);
  let links = 0;
  while (remaining.length) {
    const part = remaining.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    const info = await entryInfo(next);
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new AppError("conflict", "Too many symbolic links in the write path");
      let target = (await readlink(next)).replaceAll("/", "\\");
      if (isAbsolute(target)) {
        current = parse(target).root;
        target = target.slice(current.length);
      }
      remaining.unshift(...target.split(sep).filter(Boolean));
    } else {
      current = next;
    }
  }
  return realpath(current);
}

export async function realPath(path: string) {
  return process.platform === "win32" ? windowsRealPath(path) : realpath(path);
}

export function sameObject(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}

export async function containsDirectory(info: BigIntStats, parent: string) {
  for (;;) {
    if (sameObject(info, await stat(parent, { bigint: true }))) return true;
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
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
  const parent = await realPath(dirname(absolute));
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
  const valid = isUtf8(rawName);
  const info = valid ? await entryInfo(absolute) : await lstat(absolute, { bigint: true });
  const name = rawName.toString("utf8");
  return {
    name,
    ...(valid
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
