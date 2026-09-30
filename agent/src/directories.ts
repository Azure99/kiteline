import { randomUUID } from "node:crypto";
import { opendir, mkdir, stat } from "node:fs/promises";
import type { BigIntStats, Dir, Dirent } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { AppError, limits, type DirectoryListing, type Entry } from "@kiteline/shared/protocol";
import { publish } from "./mutations.js";
import { devicePath, entryName, readEntry, realPath, sameObject } from "./files/paths.js";
import { CursorBudget } from "./cursor-budget.js";

interface Cursor {
  path: string;
  entryParent?: string;
  directory?: Dir;
  carry: Dirent | null;
  timer: NodeJS.Timeout;
  busy: boolean;
  info?: BigIntStats;
  release: () => void;
  controller: AbortController;
  reading?: Promise<void>;
  closing?: Promise<void>;
}
export class Directories {
  private cursors = new Map<string, Cursor>();
  constructor(private budget = new CursorBudget()) {}
  async release(id: string) {
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    clearTimeout(cursor.timer);
    cursor.controller.abort(new AppError("cancelled", "Directory listing has ended"));
    cursor.closing ??= (async () => {
      await cursor.reading;
      await cursor.directory?.close().catch(() => {});
      this.cursors.delete(id);
      cursor.release();
    })();
    await cursor.closing;
  }
  async list(
    path: string,
    token?: string,
    signal?: AbortSignal,
    entryParent?: string,
  ): Promise<DirectoryListing> {
    devicePath(path);
    const relativeEntries = entryParent !== undefined;
    signal?.throwIfAborted();
    const id = token ?? randomUUID();
    let cursor = this.cursors.get(id);
    if (token && (!cursor || cursor.closing))
      throw new AppError("conflict", "Directory listing has changed or expired; refresh");
    if (!cursor) {
      const release = this.budget.reserve();
      cursor = {
        path,
        entryParent,
        carry: null,
        busy: false,
        release,
        controller: new AbortController(),
        timer: setTimeout(() => void this.release(id), limits.cursorLifetime),
      };
      this.cursors.set(id, cursor);
    }
    if (cursor.busy) throw new AppError("busy", "This directory page is being read");
    cursor.busy = true;
    cursor.timer.refresh();
    signal = AbortSignal.any([cursor.controller.signal, ...(signal ? [signal] : [])]);
    let finishRead!: () => void;
    cursor.reading = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    let more = false;
    const items: Entry[] = [];
    try {
      path = await realPath(path);
      entryParent ??= path;
      signal.throwIfAborted();
      const info = await stat(path, { bigint: true });
      signal.throwIfAborted();
      if (
        cursor.info &&
        (cursor.path !== path ||
          cursor.entryParent !== entryParent ||
          !sameObject(cursor.info, info) ||
          cursor.info.mtimeNs !== info.mtimeNs)
      )
        throw new AppError("conflict", "Directory listing has changed or expired; refresh");
      if (!cursor.directory) {
        cursor.path = path;
        cursor.entryParent = entryParent;
        cursor.info = info;
        // Node supports raw names here, but its typings omit this encoding.
        cursor.directory = await opendir(path, { encoding: "buffer" as BufferEncoding });
      }
      let bytes =
        512 +
        Buffer.byteLength(JSON.stringify(path)) * 2 +
        Buffer.byteLength(JSON.stringify(entryParent));
      while (items.length < limits.listPageEntries) {
        signal.throwIfAborted();
        const item = cursor.carry ?? (await cursor.directory.read());
        cursor.carry = null;
        signal.throwIfAborted();
        if (!item) break;
        const rawName: Buffer = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name);
        let entry: Entry;
        try {
          entry = await readEntry(
            path,
            rawName,
            (relativeEntries ? posix.join : join)(entryParent, rawName.toString("utf8")),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > limits.resultBytes) {
          if (!items.length)
            throw new AppError("limit_exceeded", "A directory entry exceeds the size limit");
          cursor.carry = item;
          break;
        }
        bytes += size + 1;
        items.push(entry);
      }
      if (items.length === limits.listPageEntries) {
        signal.throwIfAborted();
        cursor.carry ??= await cursor.directory.read();
      }
      signal.throwIfAborted();
      more = !!cursor.carry;
    } finally {
      cursor.busy = false;
      finishRead();
      if (!more || signal.aborted) await this.release(id);
    }
    items.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
    return {
      path,
      ...(dirname(path) !== path ? { parentPath: dirname(path) } : {}),
      entries: { items, ...(more ? { nextCursor: id } : {}), truncated: more },
    };
  }
  async mkdir(path: string, signal?: AbortSignal) {
    devicePath(path);
    const name = entryName(basename(path));
    return publish(async () => {
      const target = join(await realPath(dirname(path)), name);
      signal?.throwIfAborted();
      await mkdir(target);
      return { path: target };
    }, signal);
  }
  async close() {
    await Promise.all([...this.cursors.keys()].map((id) => this.release(id)));
  }
}
