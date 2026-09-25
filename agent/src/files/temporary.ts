import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, readlink, stat, symlink, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { AppError } from "@kiteline/shared/protocol";
import { atomicJson, readJson } from "../config.js";
import { publish } from "../mutations.js";
import { sameObject } from "./paths.js";

interface TemporaryRecord {
  name: string;
  parent: string;
  parentDev: string;
  parentIno: string;
  dev: string;
  ino: string;
}
export interface TrackedTemporary extends TemporaryRecord {
  path: string;
}
export interface Temporary extends TrackedTemporary {
  path: string;
  handle: FileHandle;
  closed: boolean;
}

interface WriteAccess {
  path: string;
  followFinalLink?: boolean;
}

// Retain only the directory/link identities that the actual write path traverses.
async function dependencies({ path, followFinalLink }: WriteAccess) {
  const result: BigIntStats[] = [];
  const remaining = path.split("/").filter(Boolean);
  let current = "/",
    links = 0;
  while (remaining.length) {
    const part = remaining.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (!remaining.length && !followFinalLink) {
      current = next;
      break;
    }
    const info = await lstat(next, { bigint: true });
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new AppError("conflict", "Too many symbolic links in the write path");
      result.push(info);
      const target = await readlink(next);
      if (isAbsolute(target)) current = "/";
      remaining.unshift(...target.split("/").filter(Boolean));
    } else {
      if (info.isDirectory()) result.push(info);
      current = next;
    }
  }
  return { path: current, items: result };
}

export class TemporaryFiles {
  private records: TemporaryRecord[] = [];
  private active = new Map<string, { record: TemporaryRecord; dependencies: BigIntStats[] }>();
  private path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, "temporary-files.json");
  }

  async cleanStartup() {
    try {
      this.records = (await readJson(this.path)) as TemporaryRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const record of [...this.records]) {
      try {
        await publish(() => this.removeLocked(record));
      } catch (error) {
        console.error("Temporary file cleanup:", join(record.parent, record.name), error);
      }
    }
  }

  create(
    parent: string,
    expected: BigIntStats,
    signal: AbortSignal,
    access?: WriteAccess,
  ): Promise<Temporary> {
    return publish(async () => {
      const info = await stat(parent, { bigint: true });
      if (!sameObject(info, expected))
        throw new AppError("conflict", "Target parent directory has changed");
      const route = await dependencies(access ?? { path: parent, followFinalLink: true });
      if ((access ? dirname(route.path) : route.path) !== parent)
        throw new AppError("conflict", "Write path no longer reaches the prepared parent");
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      const handle = await open(path, "wx+", 0o600);
      try {
        const file = await handle.stat({ bigint: true });
        const record = {
          parent,
          name,
          parentDev: String(info.dev),
          parentIno: String(info.ino),
          dev: String(file.dev),
          ino: String(file.ino),
        };
        this.records.push(record);
        await this.persist();
        this.active.set(path, { record, dependencies: route.items });
        return { ...record, path, handle, closed: false };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        this.records = this.records.filter((item) => item.name !== name);
        throw error;
      }
    }, signal);
  }

  createLink(
    parent: string,
    expected: BigIntStats,
    target: string | Buffer,
    signal: AbortSignal,
    access?: WriteAccess,
  ): Promise<TrackedTemporary> {
    return publish(async () => {
      const info = await stat(parent, { bigint: true });
      if (!sameObject(info, expected))
        throw new AppError("conflict", "Target parent directory has changed");
      const route = await dependencies(access ?? { path: parent, followFinalLink: true });
      if ((access ? dirname(route.path) : route.path) !== parent)
        throw new AppError("conflict", "Write path no longer reaches the prepared parent");
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      await symlink(target, path);
      try {
        const file = await lstat(path, { bigint: true });
        const record = {
          parent,
          name,
          parentDev: String(info.dev),
          parentIno: String(info.ino),
          dev: String(file.dev),
          ino: String(file.ino),
        };
        this.records.push(record);
        await this.persist();
        this.active.set(path, { record, dependencies: route.items });
        return { ...record, path };
      } catch (error) {
        await unlink(path).catch(() => {});
        this.records = this.records.filter((item) => item.name !== name);
        throw error;
      }
    }, signal);
  }

  async closeFile(temporary: Temporary) {
    if (temporary.closed) return;
    temporary.closed = true;
    await temporary.handle.close();
  }

  async write(temporary: Temporary, bytes: Buffer, position: number, signal: AbortSignal) {
    signal.throwIfAborted();
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesWritten } = await temporary.handle.write(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (!bytesWritten) throw new AppError("io_error", "File writing could not continue");
      offset += bytesWritten;
    }
    return offset;
  }

  async release(
    temporary: TrackedTemporary,
    { published, uncertain }: { published: boolean; uncertain: boolean },
  ) {
    try {
      if ("handle" in temporary) await this.closeFile(temporary as Temporary);
      if (!published && !uncertain) await this.discard(temporary);
    } finally {
      this.active.delete(temporary.path);
    }
  }

  async discard(temporary: TrackedTemporary) {
    try {
      if ("handle" in temporary) await this.closeFile(temporary as Temporary);
      await publish(() => this.removeLocked(temporary));
    } finally {
      this.active.delete(temporary.path);
    }
  }

  async checkLocked(temporary: TrackedTemporary) {
    const parent = await stat(temporary.parent, { bigint: true });
    const file = await lstat(temporary.path, { bigint: true });
    if (
      String(parent.dev) !== temporary.parentDev ||
      String(parent.ino) !== temporary.parentIno ||
      String(file.dev) !== temporary.dev ||
      String(file.ino) !== temporary.ino
    )
      throw new AppError("conflict", "Temporary file or target parent directory has changed");
  }

  async forgetLocked(record: TemporaryRecord) {
    this.active.delete(join(record.parent, record.name));
    const next = this.records.filter(
      (item) => item.parent !== record.parent || item.name !== record.name,
    );
    await atomicJson(this.path, next);
    this.records = next;
  }

  ownsLocked(location: { name: string; parentInfo: BigIntStats }, info: BigIntStats) {
    return [...this.active.values()].some(
      ({ record }) =>
        record.name === location.name &&
        record.parentDev === String(location.parentInfo.dev) &&
        record.parentIno === String(location.parentInfo.ino) &&
        record.dev === String(info.dev) &&
        record.ino === String(info.ino),
    );
  }

  async assertRelocatableLocked(
    location: { name: string; parentInfo: BigIntStats },
    info: BigIntStats,
    publishing?: TrackedTemporary,
  ) {
    const busy = () =>
      new AppError("busy", "A file write is using this location; retry after it finishes");
    if (this.ownsLocked(location, info)) throw busy();
    if (!info.isDirectory() && !info.isSymbolicLink()) return;
    for (const [path, { record, dependencies }] of this.active) {
      // This same publication releases its own temporary before changing the source.
      if (path === publishing?.path) continue;
      if (!dependencies.some((dependency) => sameObject(info, dependency))) continue;
      try {
        await this.checkLocked({ ...record, path: join(record.parent, record.name) });
      } catch (error) {
        if (
          (error instanceof AppError && error.code === "conflict") ||
          ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
        )
          continue;
        throw error;
      }
      throw busy();
    }
  }

  private async removeLocked(record: TemporaryRecord) {
    const path = join(record.parent, record.name);
    let info: BigIntStats;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing file only resolves the record if its original parent remains reachable.
        const parent = await stat(record.parent, { bigint: true });
        if (String(parent.dev) !== record.parentDev || String(parent.ino) !== record.parentIno)
          throw new AppError(
            "conflict",
            "Temporary file parent directory has changed; the location record is retained",
          );
        await this.forgetLocked(record);
        return;
      }
      throw error;
    }
    const parent = await stat(record.parent, { bigint: true });
    if (
      String(parent.dev) !== record.parentDev ||
      String(parent.ino) !== record.parentIno ||
      String(info.dev) !== record.dev ||
      String(info.ino) !== record.ino
    )
      throw new AppError(
        "conflict",
        "Temporary item identity has changed; the location record is retained",
      );
    await unlink(path);
    await this.forgetLocked(record);
  }

  private persist() {
    return atomicJson(this.path, this.records);
  }
}
