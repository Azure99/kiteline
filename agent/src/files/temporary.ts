import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, stat, symlink, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
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

export class TemporaryFiles {
  private records: TemporaryRecord[] = [];
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

  create(parent: string, expected: BigIntStats, signal: AbortSignal): Promise<Temporary> {
    return publish(async () => {
      const info = await stat(parent, { bigint: true });
      if (!sameObject(info, expected))
        throw new AppError("conflict", "Target parent directory has changed");
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
  ): Promise<TrackedTemporary> {
    return publish(async () => {
      const info = await stat(parent, { bigint: true });
      if (!sameObject(info, expected))
        throw new AppError("conflict", "Target parent directory has changed");
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
    if ("handle" in temporary) await this.closeFile(temporary as Temporary);
    if (!published && !uncertain) await this.discard(temporary);
  }

  async discard(temporary: TrackedTemporary) {
    if ("handle" in temporary) await this.closeFile(temporary as Temporary);
    await publish(() => this.removeLocked(temporary));
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
    const next = this.records.filter(
      (item) => item.parent !== record.parent || item.name !== record.name,
    );
    await atomicJson(this.path, next);
    this.records = next;
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
