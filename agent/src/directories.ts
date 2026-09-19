import { randomUUID } from "node:crypto";
import { opendir, realpath, mkdir, stat } from "node:fs/promises";
import type { BigIntStats, Dir, Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { AppError, limits, type DirectoryListing, type Entry } from "@kiteline/shared/protocol";
import { publish } from "./mutations.js";
import { readEntry, sameObject } from "./files/paths.js";
import { CursorBudget } from "./cursor-budget.js";

interface Cursor {
  path: string;
  entryParent: string;
  directory: Dir;
  carry: Dirent | null;
  timer: NodeJS.Timeout;
  busy: boolean;
  info: BigIntStats;
  release: () => void;
}
export class Directories {
  private cursors = new Map<string, Cursor>();
  constructor(private budget = new CursorBudget()) {}
  private async closeCursor(id: string) {
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    clearTimeout(cursor.timer);
    this.cursors.delete(id);
    cursor.release();
    await cursor.directory.close().catch(() => {});
  }
  async list(
    path: string,
    token?: string,
    signal?: AbortSignal,
    entryParent?: string,
  ): Promise<DirectoryListing> {
    if (!isAbsolute(path))
      throw new AppError("invalid_argument", "An absolute directory path is required");
    path = await realpath(path);
    entryParent ??= path;
    signal?.throwIfAborted();
    const id = token ?? randomUUID();
    let cursor = this.cursors.get(id);
    const info = await stat(path, { bigint: true });
    if (
      token &&
      (!cursor ||
        cursor.path !== path ||
        cursor.entryParent !== entryParent ||
        !sameObject(cursor.info, info) ||
        cursor.info.mtimeNs !== info.mtimeNs)
    ) {
      if (cursor) await this.closeCursor(id);
      throw new AppError("conflict", "Directory listing has changed or expired; refresh");
    }
    if (!cursor) {
      const release = this.budget.reserve();
      // Node 24 supports raw names here; its current typings omit this encoding.
      try {
        const directory = await opendir(path, { encoding: "buffer" as BufferEncoding });
        if (signal?.aborted) {
          await directory.close();
          signal.throwIfAborted();
        }
        cursor = {
          path,
          entryParent,
          directory,
          carry: null,
          busy: false,
          info,
          release,
          timer: setTimeout(() => {
            void this.closeCursor(id);
          }, limits.cursorLifetime),
        };
        this.cursors.set(id, cursor);
      } catch (error) {
        release();
        throw error;
      }
    }
    if (cursor.busy) throw new AppError("busy", "This directory page is being read");
    cursor.busy = true;
    cursor.timer.refresh();
    const items: Entry[] = [];
    let bytes =
      512 +
      Buffer.byteLength(JSON.stringify(path)) * 2 +
      Buffer.byteLength(JSON.stringify(entryParent));
    try {
      while (items.length < limits.listPageEntries) {
        signal?.throwIfAborted();
        const item = cursor.carry ?? (await cursor.directory.read());
        cursor.carry = null;
        if (!item) {
          await this.closeCursor(id);
          break;
        }
        const rawName: Buffer = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name);
        let entry: Entry;
        try {
          entry = await readEntry(path, rawName, join(entryParent, rawName.toString("utf8")));
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
      if (this.cursors.has(id)) {
        cursor.carry ??= await cursor.directory.read();
        if (!cursor.carry) await this.closeCursor(id);
      }
    } catch (error) {
      await this.closeCursor(id);
      throw error;
    } finally {
      cursor.busy = false;
    }
    const more = this.cursors.has(id);
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
    if (!isAbsolute(path) || !basename(path))
      throw new AppError("invalid_argument", "An absolute directory path is required");
    return publish(async () => {
      const target = join(await realpath(dirname(path)), basename(path));
      signal?.throwIfAborted();
      await mkdir(target);
      return { path: target };
    }, signal);
  }
  async close() {
    await Promise.all([...this.cursors.keys()].map((id) => this.closeCursor(id)));
  }
}
