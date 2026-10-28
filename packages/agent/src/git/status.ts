import { agentLimits } from "../limits.js";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type GitEntry,
  type GitStatus,
  type GitType,
  type Repo,
} from "@kiteline/shared/protocol";
import { gitRead } from "./process.js";
import { gitPath, NulRecords, utf8 } from "./format.js";
import { observeIndex } from "./observe.js";
import { readOperation } from "./in-progress.js";

// The final response is measured again after untracked types and operation are known.
const statusEnvelopeReserveBytes = 2048;
// Porcelain v2 ASCII fields before the pathname, including the record kind.
const porcelainHeaderFields = { "1": 8, "2": 9, u: 10 };

export function modeType(mode: string): GitType {
  if (mode === "000000") return "absent";
  if (mode === "160000") return "gitlink";
  if (mode === "120000") return "symlink";
  if (mode.startsWith("100")) return "file";
  if (mode === "040000") return "directory";
  return "other";
}
function porcelainFields(record: Buffer, count: number) {
  const header: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(32, start);
    if (end < 0) throw new AppError("io_error", "Git status record is incomplete");
    header.push(record.subarray(start, end).toString("ascii"));
    start = end + 1;
  }
  return { header, path: record.subarray(start) };
}
export async function readStatus(
  repo: Repo,
  signal: AbortSignal,
  each: (entry: GitEntry) => void,
  onHeader?: (header: string) => void,
  onRaw?: (data: Buffer) => void,
) {
  let pendingRename:
    | { entry: Omit<GitEntry, "path" | "oldPath" | "pathError">; targetPath: Buffer }
    | undefined;
  const reader = new NulRecords((record) => {
    if (pendingRename) {
      each({ ...pendingRename.entry, ...gitPath(pendingRename.targetPath, record) });
      pendingRename = undefined;
      return;
    }
    const kind = String.fromCharCode(record[0] ?? 0);
    if (kind === "#") {
      onHeader?.(utf8(record));
      return;
    }
    if (kind === "?") {
      each({
        ...gitPath(record.subarray(2)),
        types: { worktree: "other" },
        indexStatus: "?",
        worktreeStatus: "?",
        conflict: false,
      });
      return;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u")
      throw new AppError("io_error", "Unsupported Git status record");
    const { header, path } = porcelainFields(record, porcelainHeaderFields[kind]);
    const [, statuses, submodule] = header;
    let types: GitEntry["types"];
    if (kind === "u") {
      const [, , , baseMode, oursMode, theirsMode, worktreeMode] = header;
      types = {
        base: modeType(baseMode!),
        ours: modeType(oursMode!),
        theirs: modeType(theirsMode!),
        worktree: modeType(worktreeMode!),
      };
    } else {
      const [, , , headMode, indexMode, worktreeMode] = header;
      types = {
        head: modeType(headMode!),
        index: modeType(indexMode!),
        worktree: modeType(worktreeMode!),
      };
    }
    const entry: Omit<GitEntry, "path" | "oldPath" | "pathError"> = {
      indexStatus: statuses![0]!,
      worktreeStatus: statuses![1]!,
      conflict: kind === "u",
      types,
      ...(submodule![0] === "S"
        ? {
            submodule: {
              commitChanged: submodule![1] === "C",
              trackedDirty: submodule![2] === "M",
              untrackedDirty: submodule![3] === "U",
            },
          }
        : {}),
    };
    // Unlike raw diff, porcelain gives the target before the rename source.
    if (kind === "2") pendingRename = { entry, targetPath: path };
    else each({ ...entry, ...gitPath(path) });
  });
  await gitRead(
    repo.rootPath,
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    signal,
    {
      onData: (chunk) => {
        onRaw?.(chunk);
        reader.data(chunk);
      },
    },
  );
  reader.end();
  if (pendingRename) throw new AppError("io_error", "Git rename record is incomplete");
}
export async function status(
  repo: Repo,
  offset: number,
  expectedListToken: string | undefined,
  signal: AbortSignal,
): Promise<GitStatus> {
  const before = await observeIndex(repo, signal);
  const entries: GitEntry[] = [];
  const hash = createHash("sha256");
  let totalCount = 0;
  let stagedCount = 0;
  let hasConflicts = false;
  let bytes = statusEnvelopeReserveBytes;
  let full = false;
  let branch: string | undefined,
    upstream: string | undefined,
    ahead: number | undefined,
    behind: number | undefined;
  await readStatus(
    repo,
    signal,
    (entry) => {
      hasConflicts ||= entry.conflict;
      if (entry.indexStatus !== "." && entry.indexStatus !== "?" && !entry.conflict) stagedCount++;
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (size + statusEnvelopeReserveBytes > agentLimits.resultBytes)
        throw new AppError("limit_exceeded", "A Git change exceeds the size limit");
      if (totalCount++ < offset || full) return;
      if (entries.length >= agentLimits.listPageEntries || bytes + size > agentLimits.resultBytes) {
        full = true;
        return;
      }
      bytes += size;
      entries.push(entry);
    },
    (header) => {
      if (header.startsWith("# branch.head ")) {
        const value = header.slice(14);
        if (value !== "(detached)") branch = value;
      } else if (header.startsWith("# branch.upstream ")) upstream = header.slice(18);
      else if (header.startsWith("# branch.ab ")) {
        const values = header.slice(12).split(" ");
        ahead = Number(values[0]!.slice(1));
        behind = Number(values[1]!.slice(1));
      }
    },
    (chunk) => {
      hash.update(chunk);
    },
  );
  for (const entry of entries)
    if (entry.indexStatus === "?" && entry.path !== undefined) {
      const info = await lstat(join(repo.rootPath, entry.path));
      entry.types.worktree = info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "directory"
            : "other";
    }
  const listToken = createHash("sha256")
    .update(JSON.stringify([repo.id, before.token, hash.digest("hex")]))
    .digest("hex");
  if (expectedListToken !== undefined && expectedListToken !== listToken)
    throw new AppError("conflict", "Git list has changed; refresh the current page");
  const operation = await readOperation(repo, before.head, hasConflicts, signal);
  for (;;) {
    if (!entries.length && offset < totalCount)
      throw new AppError(
        "limit_exceeded",
        "A Git change and repository information exceed the size limit",
      );
    const nextOffset = offset + entries.length < totalCount ? offset + entries.length : undefined;
    const result: GitStatus = {
      head: before.head,
      branch,
      upstream,
      ahead,
      behind,
      entries,
      offset,
      nextOffset,
      totalCount,
      listToken,
      stagedCount,
      hasConflicts,
      indexToken: hasConflicts ? undefined : before.token,
      operation,
      truncated: nextOffset !== undefined,
    };
    if (Buffer.byteLength(JSON.stringify(result)) <= agentLimits.resultBytes || !entries.length)
      return result;
    entries.pop();
  }
}
