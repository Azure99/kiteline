import { agentLimits } from "../limits.js";
import { opendir, mkdir, stat } from "node:fs/promises";
import type { BigIntStats, Dir, Dirent } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { AppError, type DirectoryListing, type Entry } from "@kiteline/shared/protocol";
import { publish } from "./publish.js";
import { devicePath, entryName, readEntry, realPath, sameObject } from "./paths.js";
import { CursorBudget, CursorTable } from "../cursor-budget.js";

interface Cursor {
  path: string;
  entryParent?: string;
  directory?: Dir;
  carry: Dirent | null;
  info?: BigIntStats;
}
export class Directories {
  private cursors: CursorTable<Cursor>;
  constructor(budget = new CursorBudget()) {
    this.cursors = new CursorTable(
      budget,
      async (cursor) => {
        await cursor.directory?.close().catch(() => {});
      },
      {
        expired: "Directory listing has changed or expired; refresh",
        busy: "This directory page is being read",
        ended: "Directory listing has ended",
      },
    );
  }
  release(id: string) {
    return this.cursors.release(id);
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
    const page = this.cursors.acquire(token, () => ({ path, entryParent, carry: null }), signal);
    const { id, value: cursor } = page;
    signal = page.signal;
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
      while (items.length < agentLimits.listPageEntries) {
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
        if (bytes + size > agentLimits.resultBytes) {
          if (!items.length)
            throw new AppError("limit_exceeded", "A directory entry exceeds the size limit");
          cursor.carry = item;
          break;
        }
        bytes += size + 1;
        items.push(entry);
      }
      if (items.length === agentLimits.listPageEntries) {
        signal.throwIfAborted();
        cursor.carry ??= await cursor.directory.read();
      }
      signal.throwIfAborted();
      more = !!cursor.carry;
    } finally {
      await page.finish(more);
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
  close() {
    return this.cursors.close();
  }
}
