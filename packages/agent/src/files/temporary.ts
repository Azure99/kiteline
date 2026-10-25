import { randomUUID } from "node:crypto";
import { open, symlink, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { AppError, OperationError } from "@kiteline/shared/protocol";
import { atomicJson, readJson } from "@kiteline/shared/node/files";
import { stateFiles } from "../config.js";
import { withPublicationLock } from "./publish.js";
import { renameEntry } from "./rename.js";

interface TemporaryRecord {
  name: string;
  parent: string;
}
export class StagedEntry {
  private publication: "unpublished" | "published" | "uncertain" = "unpublished";
  constructor(
    private readonly path: string,
    private readonly remove: (published: boolean) => Promise<void>,
  ) {}

  get mayHaveChangedTarget() {
    return this.publication !== "unpublished";
  }

  async publish(target: string, options: { replace: boolean }) {
    try {
      await renameEntry(this.path, target, options);
      this.publication = "published";
    } catch (error) {
      if (error instanceof OperationError && error.outcome === "unknown")
        this.publication = "uncertain";
      throw error;
    }
  }

  dispose() {
    return this.remove(this.publication === "published");
  }
}

export class StagedFile extends StagedEntry {
  private written = 0;
  constructor(
    path: string,
    readonly handle: FileHandle,
    remove: (published: boolean) => Promise<void>,
  ) {
    super(path, remove);
  }

  get bytesWritten() {
    return this.written;
  }

  async write(bytes: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesWritten } = await this.handle.write(
        bytes,
        offset,
        bytes.length - offset,
        this.written,
      );
      if (!bytesWritten) throw new AppError("io_error", "File writing could not continue");
      offset += bytesWritten;
      this.written += bytesWritten;
    }
  }

  async seal(mode: number) {
    await this.handle.chmod(mode);
    await this.handle.close();
  }

  override async dispose() {
    try {
      await this.handle.close();
    } finally {
      await super.dispose();
    }
  }
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
      this.records.map((record) => withPublicationLock(() => this.removeLocked(record))),
    ).then(() => {});
  }

  async close() {
    await this.startup;
  }

  create(parent: string, signal: AbortSignal): Promise<StagedFile> {
    return withPublicationLock(async () => {
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      const handle = await open(path, "wx+", 0o600);
      const record = { parent, name };
      this.records.push(record);
      try {
        await atomicJson(this.path, this.records);
        return new StagedFile(path, handle, (published) =>
          withPublicationLock(() => this.removeLocked(record, published)),
        );
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
  ): Promise<StagedEntry> {
    return withPublicationLock(async () => {
      const name = `.kiteline-${randomUUID()}.tmp`;
      const path = join(parent, name);
      await symlink(target, path, type);
      const record = { parent, name };
      this.records.push(record);
      try {
        await atomicJson(this.path, this.records);
        return new StagedEntry(path, (published) =>
          withPublicationLock(() => this.removeLocked(record, published)),
        );
      } catch (error) {
        await this.removeLocked(record);
        throw error;
      }
    }, signal);
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
