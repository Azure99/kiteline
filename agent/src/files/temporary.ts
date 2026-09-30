import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat, symlink, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppError,
  asError,
  limits,
  type FileCleanup,
  type PathError,
} from "@kiteline/shared/protocol";
import { atomicJson, readJson } from "../config.js";
import { publish } from "../mutations.js";
import { entryInfo, pathDependencies, realPath, sameObject } from "./paths.js";

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
  closing?: Promise<void>;
}

interface Cleanup {
  record: TemporaryRecord;
  published: boolean;
  running?: Promise<void>;
  error?: unknown;
  retry: boolean;
}

interface WriteAccess {
  path: string;
  followFinalLink?: boolean;
}

export class TemporaryFiles {
  private records: TemporaryRecord[] = [];
  private active = new Map<string, { record: TemporaryRecord; dependencies: BigIntStats[] }>();
  private path: string;
  private cleanup = new Map<string, Cleanup>();
  private cleanupAbort = new AbortController();
  private retryTimer?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private stopping = false;
  constructor(dataDir: string) {
    this.path = join(dataDir, "temporary-files.json");
  }

  async load() {
    try {
      this.records = (await readJson(this.path)) as TemporaryRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const record of this.records) void this.clean(record);
  }

  status(): FileCleanup {
    const failures: PathError[] = [];
    let failed = 0,
      bytes = 0;
    for (const [path, item] of this.cleanup) {
      if (!item.error) continue;
      failed++;
      const error = asError(item.error);
      const failure = { path, error: { code: error.code, message: error.message.slice(0, 4096) } };
      const size = Buffer.byteLength(JSON.stringify(failure));
      if (bytes + size <= limits.resultBytes / 2 && failures.length < limits.listPageEntries) {
        failures.push(failure);
        bytes += size;
      }
    }
    return {
      pending: [...this.cleanup.values()].some((item) => !!item.running || item.retry),
      retained: this.records.length,
      failed,
      failures,
      truncated: failures.length < failed,
    };
  }

  beginClose() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.closeTimer = setTimeout(() => {
      this.cleanupAbort.abort(new AppError("cancelled", "Cleanup retained for the next start"));
    }, 5000).unref();
  }

  async drain() {
    for (;;) {
      const running = [...this.cleanup.values()].flatMap((item) =>
        item.running ? [item.running] : [],
      );
      if (!running.length) return;
      await Promise.all(running);
    }
  }

  async close() {
    this.beginClose();
    await this.drain();
    clearTimeout(this.closeTimer);
  }

  private clean(record: TemporaryRecord, published = false): Promise<void> {
    const path = join(record.parent, record.name);
    let item = this.cleanup.get(path);
    if (!item) {
      item = { record, published, retry: false };
      this.cleanup.set(path, item);
    }
    item.published ||= published;
    if (item.running) return item.running;
    item.retry = false;
    if (this.cleanupAbort.signal.aborted) return Promise.resolve();
    const current = item;
    const operation = publish(
      () => (current.published ? this.forgetLocked(record) : this.removeLocked(record)),
      this.cleanupAbort.signal,
    );
    const running = operation
      .then(
        () => {
          this.cleanup.delete(path);
        },
        (error: unknown) => {
          if (!this.cleanupAbort.signal.aborted) this.failedCleanup(current, error);
        },
      )
      .finally(() => {
        current.running = undefined;
        this.active.delete(path);
        this.retryLater();
      });
    current.running = running;
    return running;
  }

  private failedCleanup(item: Cleanup, error: unknown) {
    item.error = error;
    item.retry = !(error instanceof AppError && error.code === "conflict");
    console.error("Temporary file cleanup:", join(item.record.parent, item.record.name), error);
  }

  private retryLater() {
    if (this.stopping || this.retryTimer || ![...this.cleanup.values()].some((item) => item.retry))
      return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      for (const item of this.cleanup.values())
        if (item.retry) void this.clean(item.record, item.published);
    }, 30_000).unref();
  }

  create(
    parent: string,
    expected: BigIntStats,
    signal: AbortSignal,
    access?: WriteAccess,
  ): Promise<Temporary> {
    return publish(async () => {
      const info = await stat(await realPath(parent), { bigint: true });
      if (!sameObject(info, expected))
        throw new AppError("conflict", "Target parent directory has changed");
      const route = await pathDependencies(
        access?.path ?? parent,
        access ? !!access.followFinalLink : true,
      );
      if ((access ? dirname(route.path) : route.path) !== parent)
        throw new AppError("conflict", "Write path no longer reaches the prepared parent");
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      const handle = await open(path, "wx+", 0o600);
      let record: TemporaryRecord | undefined;
      try {
        const file = await handle.stat({ bigint: true });
        record = {
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
        return { ...record, path, handle };
      } catch (error) {
        await handle
          .close()
          .catch((closeError: unknown) => console.error("Temporary file close:", path, closeError));
        if (record) await this.rollbackLocked(record);
        else console.error("Temporary file identity could not be recorded:", path, error);
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
    type?: "file" | "dir" | "junction",
  ): Promise<TrackedTemporary> {
    return publish(async () => {
      const info = await stat(await realPath(parent), { bigint: true });
      if (!sameObject(info, expected))
        throw new AppError("conflict", "Target parent directory has changed");
      const route = await pathDependencies(
        access?.path ?? parent,
        access ? !!access.followFinalLink : true,
      );
      if ((access ? dirname(route.path) : route.path) !== parent)
        throw new AppError("conflict", "Write path no longer reaches the prepared parent");
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      await symlink(target, path, type);
      let record: TemporaryRecord | undefined;
      try {
        const file = await entryInfo(path);
        record = {
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
        if (record) await this.rollbackLocked(record);
        else console.error("Temporary link identity could not be recorded:", path, error);
        throw error;
      }
    }, signal);
  }

  closeFile(temporary: Temporary) {
    return (temporary.closing ??= temporary.handle.close());
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
    { published }: { published: boolean; uncertain: boolean },
  ) {
    try {
      if ("handle" in temporary) await this.closeFile(temporary as Temporary);
    } finally {
      if (
        this.records.some(
          (item) => item.parent === temporary.parent && item.name === temporary.name,
        )
      )
        await this.clean(temporary, published);
      this.active.delete(temporary.path);
    }
  }

  discard(temporary: TrackedTemporary) {
    return this.release(temporary, { published: false, uncertain: false });
  }

  private async rollbackLocked(record: TemporaryRecord) {
    if (this.cleanupAbort.signal.aborted) return this.clean(record);
    try {
      await this.removeLocked(record);
    } catch (error) {
      const item: Cleanup = { record, published: false, retry: false };
      this.cleanup.set(join(record.parent, record.name), item);
      this.failedCleanup(item, error);
      this.retryLater();
    }
  }

  async publishedLocked(temporary: TrackedTemporary) {
    if (this.cleanupAbort.signal.aborted) return this.clean(temporary, true);
    try {
      await this.forgetLocked(temporary);
    } catch (error) {
      const item: Cleanup = { record: temporary, published: true, retry: false };
      this.cleanup.set(temporary.path, item);
      this.failedCleanup(item, error);
      this.retryLater();
    }
  }

  async checkLocked(temporary: TrackedTemporary) {
    const parent = await stat(await realPath(temporary.parent), { bigint: true });
    const file = await entryInfo(temporary.path);
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
        (process.platform === "win32" || record.name === location.name) &&
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
      await realPath(record.parent);
      info = await entryInfo(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing file only resolves the record if its original parent remains reachable.
        const parent = await stat(await realPath(record.parent), { bigint: true });
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
    const parent = await stat(await realPath(record.parent), { bigint: true });
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
