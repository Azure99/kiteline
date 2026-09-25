import { isUtf8 } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppError,
  OperationError,
  asError,
  limits,
  record,
  type CopyItem,
  type KitelineError,
  type FileItemResult,
  type FileProgress,
  type PathError,
} from "@kiteline/shared/protocol";
import type { MetadataStore } from "../metadata.js";
import { publish } from "../mutations.js";
import { locate, protectRoot, relativePath, sameObject } from "./paths.js";
import { checkTarget, targetAgain } from "./destination.js";
import { renameNoReplace } from "./rename.js";
import { TemporaryFiles, type TrackedTemporary } from "./temporary.js";

interface ObjectRef {
  path: string;
  location: Awaited<ReturnType<typeof locate>>;
  info: BigIntStats;
}
interface ResultState {
  completed: number;
  failed: number;
  failures: PathError[];
  detailBytes: number;
  budget: number;
  truncated: boolean;
  unknown: boolean;
  error?: KitelineError;
}

export class FileOperations {
  constructor(
    private metadata: MetadataStore,
    private temporary: TemporaryFiles,
  ) {}

  async run(
    kind: "copy" | "move" | "delete",
    workspaceId: string,
    inputs: unknown,
    signal: AbortSignal,
    progress?: (value: FileProgress) => void,
  ) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > limits.listPageEntries)
      throw new AppError("invalid_argument", "Select a limited number of files");
    const items: CopyItem[] = inputs.map((input: unknown) => {
      if (kind === "delete")
        return { path: relativePath(input), targetPath: "", collision: "error" };
      const item = record(input);
      if (item.collision !== "error" && item.collision !== "replace")
        throw new AppError("invalid_argument", "Invalid name conflict action");
      if (
        item.collision === "replace"
          ? typeof item.expectedTargetVersion !== "string"
          : item.expectedTargetVersion !== undefined
      )
        throw new AppError("invalid_argument", "Replacement requires the confirmed target version");
      return {
        path: relativePath(item.path),
        targetPath: relativePath(item.targetPath),
        collision: item.collision,
        expectedTargetVersion: item.expectedTargetVersion as string | undefined,
      };
    });
    if (Buffer.byteLength(JSON.stringify(items)) > limits.resultBytes / 2)
      throw new AppError(
        "limit_exceeded",
        "Selected paths exceed the operation limit; process them in batches",
      );
    const root = this.metadata.workspace(workspaceId).path;
    const results: FileItemResult[] = [];
    let totalCompleted = 0,
      bytes = 0,
      lastProgress = 0;
    const report = (path: string, count = 0, written = 0, force = false) => {
      totalCompleted += count;
      bytes += written;
      if (force || Date.now() - lastProgress >= 200) {
        lastProgress = Date.now();
        progress?.({ phase: "running", currentPath: path, completedItems: totalCompleted, bytes });
      }
    };
    progress?.({ phase: "queued", completedItems: 0, bytes: 0 });
    for (const item of items) {
      const state: ResultState = {
        completed: 0,
        failed: 0,
        failures: [],
        detailBytes: 0,
        budget: Math.floor(limits.resultBytes / (items.length * 4)),
        truncated: false,
        unknown: false,
      };
      const done = (path: string) => {
        state.completed++;
        report(path, 1);
      };
      try {
        signal.throwIfAborted();
        const source = await publish(async () => {
          const source = await capture(root, item.path);
          if (kind !== "copy") await protectRoot(root, source.path, source.info);
          return source;
        }, signal);
        if (kind === "delete") await this.remove(root, source, signal, state, done);
        else
          await this.copyMove(root, source, item, kind === "move", signal, state, done, (count) =>
            report(source.path, 0, count),
          );
      } catch (error) {
        fail(state, item.path, error);
      }
      const error = state.error;
      results.push({
        path: item.path,
        ...(kind !== "delete" ? { targetPath: item.targetPath } : {}),
        outcome: state.unknown
          ? "unknown"
          : state.failed
            ? state.completed
              ? "partial"
              : "failed"
            : "succeeded",
        completedItems: state.completed,
        ...(error ? { error } : {}),
        ...(state.failed ? { failures: state.failures, truncated: state.truncated } : {}),
      });
      report(item.path, 0, 0, true);
    }
    const result = { items: results };
    if (results.some((item) => item.outcome !== "succeeded")) {
      const outcome = results.some((item) => item.outcome === "unknown")
        ? "unknown"
        : totalCompleted
          ? "partial"
          : "failed";
      const error = results.find((item) => item.error)?.error;
      throw new OperationError(
        error?.code ?? "io_error",
        error?.message ?? "Some items were not completed",
        outcome,
        result,
      );
    }
    return result;
  }

  private async remove(
    root: string,
    source: ObjectRef,
    signal: AbortSignal,
    result: ResultState,
    done: (path: string) => void,
  ) {
    signal.throwIfAborted();
    if (source.info.isDirectory()) {
      await this.children(root, source, signal, result, async (child) =>
        this.remove(root, child, signal, result, done),
      );
    } else if (!source.info.isFile() && !source.info.isSymbolicLink()) {
      throw new AppError("unsupported", "Device nodes, sockets, and FIFOs cannot be deleted");
    }
    await publish(async () => {
      const current = await verify(root, source);
      signal.throwIfAborted();
      if (current.info.isDirectory()) await rmdir(current.location.absolute);
      else await unlink(current.location.absolute);
      done(source.path);
    }, signal);
  }

  private async copyMove(
    root: string,
    source: ObjectRef,
    item: CopyItem,
    move: boolean,
    signal: AbortSignal,
    result: ResultState,
    done: (path: string) => void,
    bytes: (count: number) => void,
    expectedParent?: ObjectRef,
  ) {
    if (!source.info.isDirectory() && !source.info.isFile() && !source.info.isSymbolicLink())
      throw new AppError("unsupported", "Device nodes, sockets, and FIFOs cannot be copied");
    const target = await publish(async () => {
      await verify(root, source);
      const target = await locate(root, item.targetPath);
      if (expectedParent && !sameObject(target.parentInfo, expectedParent.info))
        throw new AppError("conflict", "Target directory has changed");
      if (source.location.absolute === target.absolute)
        throw new AppError("invalid_argument", "Source and target are the same");
      if (source.info.isDirectory()) await outsideDirectory(source, target.parent);
      await checkTarget(target, item, source.info.isDirectory());
      return target;
    }, signal);
    if (move) {
      try {
        await publish(async () => {
          await verify(root, source);
          await this.temporary.assertRelocatableLocked(source.location, source.info);
          const current = await targetAgain(root, item.targetPath, target);
          const destination = await checkTarget(current, item, source.info.isDirectory());
          if (destination) await this.temporary.assertRelocatableLocked(current, destination);
          if (destination && sameObject(source.info, destination))
            throw new AppError(
              "invalid_argument",
              "Source and target refer to the same directory entry object",
            );
          signal.throwIfAborted();
          if (item.collision === "replace")
            await rename(source.location.absolute, current.absolute);
          else await renameNoReplace(source.location.absolute, current.absolute);
          done(source.path);
        }, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      }
    }
    if (source.info.isDirectory()) {
      const created = await publish(async () => {
        const current = await targetAgain(root, item.targetPath, target);
        signal.throwIfAborted();
        await mkdir(current.absolute, { mode: Number(source.info.mode & 0o777n) | 0o700 });
        done(item.targetPath);
        return capture(root, item.targetPath);
      }, signal);
      await this.children(
        root,
        source,
        signal,
        result,
        async (child) => {
          const childTarget = join(item.targetPath, child.location.name);
          await this.copyMove(
            root,
            child,
            { path: child.path, targetPath: childTarget, collision: "error" },
            move,
            signal,
            result,
            done,
            bytes,
            created,
          );
        },
        { omitTemporary: true },
      );
      await publish(async () => {
        await verify(root, created);
        signal.throwIfAborted();
        await chmod(created.location.absolute, Number(source.info.mode & 0o777n));
      }, signal);
      if (move)
        await publish(async () => {
          await verify(root, source);
          await this.temporary.assertRelocatableLocked(source.location, source.info);
          signal.throwIfAborted();
          await rmdir(source.location.absolute);
        }, signal);
      return;
    }

    let temporary: TrackedTemporary | undefined;
    let published = false,
      uncertain = false;
    let copied = source;
    try {
      if (source.info.isSymbolicLink()) {
        const text = await readlink(source.location.absolute, { encoding: "buffer" });
        temporary = await this.temporary.createLink(
          target.parent,
          target.parentInfo,
          text,
          signal,
          { path: join(root, item.targetPath) },
        );
      } else {
        const file = await open(
          source.location.absolute,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat({ bigint: true });
          if (!info.isFile() || !sameObject(info, source.info))
            throw new AppError("conflict", "Source file has changed");
          copied = { ...source, info };
          const output = await this.temporary.create(target.parent, target.parentInfo, signal, {
            path: join(root, item.targetPath),
          });
          temporary = output;
          const block = Buffer.alloc(limits.dataChunkBytes);
          let position = 0;
          while (position < Number(info.size)) {
            signal.throwIfAborted();
            const { bytesRead } = await file.read(
              block,
              0,
              Math.min(block.length, Number(info.size) - position),
              position,
            );
            if (!bytesRead) throw new AppError("conflict", "Source file shrank during copying");
            await this.temporary.write(output, block.subarray(0, bytesRead), position, signal);
            position += bytesRead;
            bytes(bytesRead);
          }
          const after = await file.stat({ bigint: true });
          if (!sameContentStat(info, after))
            throw new AppError("conflict", "Source file changed during copying");
          await output.handle.chmod(Number(info.mode & 0o777n));
          await this.temporary.closeFile(output);
        } finally {
          await file.close();
        }
      }
      await publish(async () => {
        await this.temporary.checkLocked(temporary!);
        const current = await targetAgain(root, item.targetPath, target);
        const destination = await checkTarget(current, item, false);
        if (move) {
          await this.temporary.assertRelocatableLocked(source.location, source.info, temporary);
          if (destination)
            await this.temporary.assertRelocatableLocked(current, destination, temporary);
        }
        signal.throwIfAborted();
        if (item.collision === "replace") await rename(temporary!.path, current.absolute);
        else await renameNoReplace(temporary!.path, current.absolute);
        published = true;
        done(item.targetPath);
        await this.temporary.forgetLocked(temporary!);
      }, signal);
      if (move)
        await publish(async () => {
          await verify(root, copied, true);
          await this.temporary.assertRelocatableLocked(copied.location, copied.info);
          signal.throwIfAborted();
          await unlink(copied.location.absolute);
        }, signal);
    } catch (error) {
      if (error instanceof OperationError && error.outcome === "unknown") uncertain = true;
      throw error;
    } finally {
      if (temporary) await this.temporary.release(temporary, { published, uncertain });
    }
  }

  private async children(
    root: string,
    source: ObjectRef,
    signal: AbortSignal,
    result: ResultState,
    visit: (child: ObjectRef) => Promise<void>,
    { omitTemporary = false }: { omitTemporary?: boolean } = {},
  ) {
    await publish(() => verify(root, source), signal);
    const directory = await opendir(source.location.absolute, {
      encoding: "buffer" as BufferEncoding,
    });
    try {
      for (;;) {
        signal.throwIfAborted();
        await publish(() => verify(root, source), signal);
        const entry = await directory.read();
        if (!entry) break;
        const raw = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
        const path = join(source.path, raw.toString("utf8"));
        try {
          if (!isUtf8(raw))
            throw new AppError("unsupported", "Name is not valid UTF-8; the item is retained");
          const child = await publish(async () => {
            await verify(root, source);
            const child = await capture(root, path);
            return omitTemporary && this.temporary.ownsLocked(child.location, child.info)
              ? undefined
              : child;
          }, signal);
          if (child) await visit(child);
        } catch (error) {
          fail(result, path, error);
        }
      }
    } finally {
      await directory.close();
    }
  }
}

async function capture(root: string, path: string): Promise<ObjectRef> {
  const location = await locate(root, path);
  return { path, location, info: await lstat(location.absolute, { bigint: true }) };
}
async function verify(root: string, original: ObjectRef, content = false) {
  const current = await capture(root, original.path);
  if (
    current.location.parent !== original.location.parent ||
    !sameObject(current.location.parentInfo, original.location.parentInfo) ||
    !sameObject(current.info, original.info) ||
    (content && !sameContentStat(current.info, original.info))
  )
    throw new AppError(
      "conflict",
      "Source path or file has changed; the current object is retained",
    );
  return current;
}
function sameContentStat(a: BigIntStats, b: BigIntStats) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function outsideDirectory(source: ObjectRef, parent: string) {
  for (;;) {
    if (sameObject(source.info, await stat(parent, { bigint: true })))
      throw new AppError(
        "invalid_argument",
        "Cannot copy or move an item into itself or a subdirectory",
      );
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}
function fail(state: ResultState, path: string, error: unknown) {
  state.failed++;
  if (error instanceof OperationError && error.outcome === "unknown") state.unknown = true;
  const failure = { path, error: asError(error) };
  if (!state.error) {
    const length = Math.max(16, Math.floor((state.budget - 100) / 3));
    state.error = { code: failure.error.code, message: failure.error.message.slice(0, length) };
    state.detailBytes += Buffer.byteLength(JSON.stringify(state.error));
    if (state.error.message.length !== failure.error.message.length) state.truncated = true;
  }
  const size = Buffer.byteLength(JSON.stringify(failure));
  if (state.detailBytes + size <= state.budget && state.failures.length < limits.listPageEntries) {
    state.failures.push(failure);
    state.detailBytes += size;
  } else state.truncated = true;
}
