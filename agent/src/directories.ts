import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { opendir, lstat, readlink, realpath, mkdir } from "node:fs/promises";
import type { Dir, Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { AppError, limits, type DirectoryListing, type Entry } from "@kiteline/shared/protocol";
import { publish } from "./mutations.js";

interface Cursor {
  path: string;
  directory: Dir;
  carry: Dirent | null;
  timer: NodeJS.Timeout;
  busy: boolean;
}
export class Directories {
  private cursors = new Map<string, Cursor>();
  private opening = 0;
  private async closeCursor(id: string) {
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    clearTimeout(cursor.timer);
    this.cursors.delete(id);
    await cursor.directory.close().catch(() => {});
  }
  async list(path: string, token?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    if (!isAbsolute(path)) throw new AppError("invalid_argument", "需要绝对目录路径");
    path = await realpath(path);
    signal?.throwIfAborted();
    const id = token ?? randomUUID();
    let cursor = this.cursors.get(id);
    if (token && (!cursor || cursor.path !== path))
      throw new AppError("conflict", "目录列表已过期，请刷新");
    if (!cursor) {
      if (this.cursors.size + this.opening >= limits.cursorsPerDevice)
        throw new AppError("busy", "目录列表过多，请关闭旧列表后重试");
      this.opening++;
      // Node 24 supports raw names here; its current typings omit this encoding.
      try {
        const directory = await opendir(path, { encoding: "buffer" as BufferEncoding });
        if (signal?.aborted) {
          await directory.close();
          signal.throwIfAborted();
        }
        cursor = {
          path,
          directory,
          carry: null,
          busy: false,
          timer: setTimeout(() => {
            void this.closeCursor(id);
          }, limits.cursorLifetime),
        };
        this.cursors.set(id, cursor);
      } finally {
        this.opening--;
      }
    }
    if (cursor.busy) throw new AppError("busy", "该目录页正在读取");
    cursor.busy = true;
    cursor.timer.refresh();
    const items: Entry[] = [];
    let bytes = 512;
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
        const name = rawName.toString("utf8");
        const actual = Buffer.concat([
          Buffer.from(path.endsWith("/") ? path : path + "/"),
          rawName,
        ]);
        const valid = isUtf8(rawName);
        let entry: Entry;
        try {
          const info = await lstat(actual);
          entry = {
            name,
            ...(valid
              ? { path: join(path, name) }
              : { path: null, unavailableReason: "invalid_utf8" as const }),
            kind: info.isDirectory()
              ? "directory"
              : info.isFile()
                ? "file"
                : info.isSymbolicLink()
                  ? "symlink"
                  : "other",
            size: info.size,
            mtime: info.mtime.toISOString(),
            ...(info.isSymbolicLink() ? { linkTarget: await readlink(actual) } : {}),
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > limits.resultBytes) {
          if (!items.length) throw new AppError("limit_exceeded", "单个目录项超过容量");
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
      throw new AppError("invalid_argument", "需要绝对目录路径");
    const target = join(await realpath(dirname(path)), basename(path));
    return publish(async () => {
      await mkdir(target);
      return { path: target };
    }, signal);
  }
  async close() {
    await Promise.all([...this.cursors.keys()].map((id) => this.closeCursor(id)));
  }
}
