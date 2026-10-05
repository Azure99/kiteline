import { agentLimits } from "../limits.js";
import { isUtf8 } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import { chmod, mkdir, open, opendir, readlink, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";
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
import { publish } from "./publish.js";
import {
  containsDirectory,
  entryInfo,
  linkType,
  locate,
  logicalPath,
  protectRoot,
  relativePath,
  sameObject,
} from "./paths.js";
import { checkTarget, targetAgain } from "./destination.js";
import { renameEntry } from "./rename.js";
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
  finished: boolean;
  changing: boolean;
  error?: KitelineError;
}
interface OperationContext {
  root: string;
  signal: AbortSignal;
  result: ResultState;
  countCompleted: (path: string) => void;
  reportBytes: (count: number) => void;
}

export class FileOperations {
  private executions = new Map<
    Promise<void>,
    { controller: AbortController; signal: AbortSignal }
  >();
  private closing = false;
  constructor(
    private metadata: MetadataStore,
    private temporary: TemporaryFiles,
    private changed: (workspaceId: string) => void = () => {},
  ) {}

  async close() {
    this.closing = true;
    for (const { controller } of this.executions.values())
      controller.abort(new AppError("cancelled", "Agent is stopping"));
    await Promise.allSettled([...this.executions.keys()]);
  }

  async run(
    kind: "copy" | "move" | "delete",
    workspaceId: string,
    inputs: unknown,
    signal: AbortSignal,
    progress?: (value: FileProgress) => void,
  ) {
    if (this.closing) throw new AppError("cancelled", "Agent is stopping");
    if (this.executions.size >= limits.pendingRequestsPerDevice)
      throw new AppError("busy", "File operations are still finishing; try again later");
    const items = parseItems(kind, inputs);
    const root = this.metadata.workspace(workspaceId).path;
    const controller = new AbortController();
    signal = AbortSignal.any([signal, controller.signal]);
    const states: ResultState[] = items.map(() => ({
      completed: 0,
      failed: 0,
      failures: [],
      detailBytes: 0,
      budget: Math.floor(agentLimits.resultBytes / (items.length * 4)),
      truncated: false,
      unknown: false,
      finished: false,
      changing: false,
    }));
    let resolve!: (result: { items: FileItemResult[] }) => void;
    let reject!: (error: unknown) => void;
    let settled = false;
    const response = new Promise<{ items: FileItemResult[] }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let totalCompleted = 0,
      bytes = 0,
      lastProgress = 0;
    const report = (path: string, count = 0, written = 0, force = false) => {
      totalCompleted += count;
      bytes += written;
      if (!settled && (force || Date.now() - lastProgress >= 200)) {
        lastProgress = Date.now();
        progress?.({ phase: "running", currentPath: path, completedItems: totalCompleted, bytes });
      }
    };
    progress?.({ phase: "queued", completedItems: 0, bytes: 0 });
    const settle = (cancellation?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      const results = items.map((item, index) =>
        itemResult(item, states[index]!, kind, cancellation),
      );
      const result = { items: results };
      if (results.every((item) => item.outcome === "succeeded")) return resolve(result);
      const outcome = results.some((item) => item.outcome === "unknown")
        ? "unknown"
        : results.some((item) => item.completedItems)
          ? "partial"
          : "failed";
      const error = results.find((item) => item.error)?.error;
      reject(
        new OperationError(
          error?.code ?? "io_error",
          error?.message ?? "Some items were not completed",
          outcome,
          result,
        ),
      );
    };
    const cancel = () => settle(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const execution = (async () => {
      for (const [index, item] of items.entries()) {
        const state = states[index]!;
        const markFinished = () => {
          state.finished = true;
        };
        const countCompleted = (path: string) => {
          state.completed++;
          report(path, 1);
        };
        try {
          signal.throwIfAborted();
          const source = await publish(async () => {
            const path = await logicalPath(root, item.path, false, signal);
            if (kind !== "delete")
              item.targetPath = await logicalPath(
                root,
                item.targetPath,
                item.collision !== "replace",
                signal,
              );
            const source = await capture(root, path);
            if (kind !== "copy") await protectRoot(root, source.path, source.info);
            return source;
          }, signal);
          const context: OperationContext = {
            root,
            signal,
            result: state,
            countCompleted,
            reportBytes: (count) => report(source.path, 0, count),
          };
          if (kind === "delete") await this.remove(context, source, markFinished);
          else
            await this.copyMove(context, {
              source,
              item,
              move: kind === "move",
              markFinished,
            });
        } catch (error) {
          fail(state, item.path, error);
        }
        state.finished = true;
        report(item.path, 0, 0, true);
      }
    })();
    this.executions.set(execution, { controller, signal });
    void execution
      .then(() => settle(), reject)
      .finally(() => {
        signal.removeEventListener("abort", cancel);
        this.executions.delete(execution);
        this.changed(workspaceId);
      })
      .catch((error: unknown) => console.error("File operation completion:", error));
    return response;
  }

  private async remove(
    context: OperationContext,
    source: ObjectRef,
    markFinished: () => void = () => {},
  ) {
    const { root, signal, result, countCompleted } = context;
    signal.throwIfAborted();
    if (source.info.isDirectory()) {
      await this.children(root, source, signal, result, async (child) =>
        this.remove(context, child),
      );
    } else if (!source.info.isFile() && !source.info.isSymbolicLink()) {
      throw new AppError("unsupported", "Device nodes, sockets, and FIFOs cannot be deleted");
    }
    await publish(async () => {
      const current = await verify(root, source);
      await change(
        result,
        signal,
        () =>
          current.info.isDirectory()
            ? rmdir(current.location.absolute)
            : unlink(current.location.absolute),
        () => {
          markFinished();
          countCompleted(source.path);
        },
      );
    }, signal);
  }

  private async copyMove(
    context: OperationContext,
    {
      source,
      item,
      move,
      expectedParent,
      markFinished = () => {},
    }: {
      source: ObjectRef;
      item: CopyItem;
      move: boolean;
      expectedParent?: ObjectRef;
      markFinished?: () => void;
    },
  ) {
    const { root, signal, result, countCompleted, reportBytes } = context;
    if (!source.info.isDirectory() && !source.info.isFile() && !source.info.isSymbolicLink())
      throw new AppError("unsupported", "Device nodes, sockets, and FIFOs cannot be copied");
    const target = await publish(async () => {
      await verify(root, source);
      const target = await locate(root, item.targetPath);
      if (expectedParent && !sameObject(target.parentInfo, expectedParent.info))
        throw new AppError("conflict", "Target directory has changed");
      if (source.location.absolute === target.absolute)
        throw new AppError("invalid_argument", "Source and target are the same");
      if (source.info.isDirectory() && (await containsDirectory(source.info, target.parent)))
        throw new AppError(
          "invalid_argument",
          "Cannot copy or move an item into itself or a subdirectory",
        );
      await checkTarget(target, item, source.info.isDirectory());
      return target;
    }, signal);
    if (move) {
      try {
        await publish(async () => {
          await verify(root, source);
          const current = await targetAgain(root, item.targetPath, target);
          const destination = await checkTarget(current, item, source.info.isDirectory());
          if (destination && sameObject(source.info, destination))
            throw new AppError(
              "invalid_argument",
              "Source and target refer to the same directory entry object",
            );
          await change(
            result,
            signal,
            () =>
              renameEntry(source.location.absolute, current.absolute, {
                replace: item.collision === "replace",
              }),
            () => {
              markFinished();
              countCompleted(source.path);
            },
          );
        }, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      }
    }
    if (source.info.isDirectory()) {
      const created = await publish(async () => {
        const current = await targetAgain(root, item.targetPath, target);
        await change(
          result,
          signal,
          () => mkdir(current.absolute, { mode: Number(source.info.mode & 0o777n) | 0o700 }),
          () => countCompleted(item.targetPath),
        );
        return capture(root, item.targetPath);
      }, signal);
      await this.children(root, source, signal, result, async (child) => {
        const childTarget = posix.join(item.targetPath, child.location.name);
        await this.copyMove(context, {
          source: child,
          item: { path: child.path, targetPath: childTarget, collision: "error" },
          move,
          expectedParent: created,
        });
      });
      await publish(async () => {
        await verify(root, created);
        await change(
          result,
          signal,
          () => chmod(created.location.absolute, Number(source.info.mode & 0o777n)),
          () => {
            if (!move) markFinished();
          },
        );
      }, signal);
      if (move)
        await publish(async () => {
          await verify(root, source);
          await change(result, signal, () => rmdir(source.location.absolute), markFinished);
        }, signal);
      return;
    }

    let temporary: TrackedTemporary | undefined;
    let published = false;
    let copied = source;
    try {
      if (source.info.isSymbolicLink()) {
        const text = await readlink(source.location.absolute, { encoding: "buffer" });
        temporary = await this.temporary.createLink(
          target.parent,
          text,
          signal,
          await linkType(source.location.absolute),
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
          const output = await this.temporary.create(target.parent, signal);
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
            reportBytes(bytesRead);
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
        const current = await targetAgain(root, item.targetPath, target);
        await checkTarget(current, item, false);
        await change(
          result,
          signal,
          () =>
            renameEntry(temporary!.path, current.absolute, {
              replace: item.collision === "replace",
            }),
          () => {
            published = true;
            if (!move) markFinished();
            countCompleted(item.targetPath);
          },
        );
      }, signal);
      if (move)
        await publish(async () => {
          await verify(root, copied, true);
          await change(result, signal, () => unlink(copied.location.absolute), markFinished);
        }, signal);
    } finally {
      if (temporary) await this.temporary.release(temporary, { published });
    }
  }

  private async children(
    root: string,
    source: ObjectRef,
    signal: AbortSignal,
    result: ResultState,
    visit: (child: ObjectRef) => Promise<void>,
  ) {
    const directory = await opendir(source.location.absolute, {
      encoding: "buffer" as BufferEncoding,
    });
    try {
      for (;;) {
        signal.throwIfAborted();
        const entry = await directory.read();
        if (!entry) break;
        const raw = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
        const path = posix.join(source.path, raw.toString("utf8"));
        try {
          if (!isUtf8(raw))
            throw new AppError("unsupported", "Name is not valid UTF-8; the item is retained");
          const child = await publish(async () => {
            await verify(root, source);
            return capture(root, path);
          }, signal);
          await visit(child);
        } catch (error) {
          fail(result, path, error);
        }
      }
    } finally {
      await directory.close();
    }
  }
}

function parseItems(kind: "copy" | "move" | "delete", inputs: unknown): CopyItem[] {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > agentLimits.listPageEntries)
    throw new AppError("invalid_argument", "Select a limited number of files");
  const items: CopyItem[] = inputs.map((input: unknown) => {
    if (kind === "delete") return { path: relativePath(input), targetPath: "", collision: "error" };
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
  if (Buffer.byteLength(JSON.stringify(items)) > agentLimits.resultBytes / 2)
    throw new AppError(
      "limit_exceeded",
      "Selected paths exceed the operation limit; process them in batches",
    );
  return items;
}

function itemResult(
  item: CopyItem,
  source: ResultState,
  kind: "copy" | "move" | "delete",
  cancellation?: unknown,
): FileItemResult {
  const state = { ...source, failures: [...source.failures] };
  if (!state.finished && cancellation) {
    if (state.changing) state.unknown = true;
    fail(state, item.path, cancellation);
  }
  return {
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
    ...(state.error ? { error: state.error } : {}),
    ...(state.failed ? { failures: state.failures, truncated: state.truncated } : {}),
  };
}

async function change<T>(
  state: ResultState,
  signal: AbortSignal,
  action: () => Promise<T>,
  confirmed: () => void,
) {
  signal.throwIfAborted();
  state.changing = true;
  let value: T;
  try {
    value = await action();
  } catch (error) {
    if (error instanceof OperationError && error.outcome === "unknown") state.unknown = true;
    throw error;
  } finally {
    state.changing = false;
  }
  confirmed();
  return value;
}

async function capture(root: string, path: string): Promise<ObjectRef> {
  const location = await locate(root, path);
  return { path, location, info: await entryInfo(location.absolute) };
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
  if (
    state.detailBytes + size <= state.budget &&
    state.failures.length < agentLimits.listPageEntries
  ) {
    state.failures.push(failure);
    state.detailBytes += size;
  } else state.truncated = true;
}
