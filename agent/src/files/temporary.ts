import { randomUUID } from "node:crypto";
import { open, symlink, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@kiteline/shared/protocol";
import { atomicJson, readJson, stateFiles } from "../config.js";
import { publish } from "./publish.js";

interface TemporaryRecord {
  name: string;
  parent: string;
}
export interface TrackedTemporary extends TemporaryRecord {
  path: string;
}
export interface Temporary extends TrackedTemporary {
  handle: FileHandle;
}

export class TemporaryFiles {
  private records: TemporaryRecord[] = [];
  private path: string;
  private startup?: Promise<void>;
  constructor(dataDir: string) {
    this.path = join(dataDir, stateFiles.temporaryFiles);
  }

  async load() {
    try {
      const records = await readJson(this.path);
      if (!Array.isArray(records)) throw new Error("Temporary records must be an array");
      this.records = records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("Temporary file records:", this.path, error);
    }
    this.startup = Promise.all(
      this.records.map((record) => publish(() => this.removeLocked(record))),
    ).then(() => {});
  }

  async close() {
    await this.startup;
  }

  create(parent: string, signal: AbortSignal): Promise<Temporary> {
    return publish(async () => {
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      const handle = await open(path, "wx+", 0o600);
      const record = { parent, name };
      this.records.push(record);
      try {
        await atomicJson(this.path, this.records);
        return { ...record, path, handle };
      } catch (error) {
        await handle
          .close()
          .catch((closeError: unknown) => console.error("Temporary file close:", path, closeError));
        await this.removeLocked(record);
        throw error;
      }
    }, signal);
  }

  createLink(
    parent: string,
    target: string | Buffer,
    signal: AbortSignal,
    type?: "file" | "dir" | "junction",
  ): Promise<TrackedTemporary> {
    return publish(async () => {
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      await symlink(target, path, type);
      const record = { parent, name };
      this.records.push(record);
      try {
        await atomicJson(this.path, this.records);
        return { ...record, path };
      } catch (error) {
        await this.removeLocked(record);
        throw error;
      }
    }, signal);
  }

  closeFile(temporary: Temporary) {
    return temporary.handle.close();
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

  async release(temporary: TrackedTemporary, { published }: { published: boolean }) {
    try {
      if ("handle" in temporary) await this.closeFile(temporary as Temporary);
    } finally {
      await publish(() => this.removeLocked(temporary, published));
    }
  }

  private async removeLocked(record: TemporaryRecord, published = false) {
    try {
      if (!published) {
        try {
          await unlink(join(record.parent, record.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const next = this.records.filter(
        (item) => item.parent !== record.parent || item.name !== record.name,
      );
      await atomicJson(this.path, next);
      this.records = next;
    } catch (error) {
      console.error("Temporary file cleanup:", record, error);
    }
  }
}
