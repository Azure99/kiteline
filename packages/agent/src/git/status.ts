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
import { git, gitPath, NulRecords, utf8 } from "./process.js";
import { observeIndex } from "./observe.js";
import { readOperation } from "./in-progress.js";

export function modeType(mode: string): GitType {
  if (mode === "000000") return "absent";
  if (mode === "160000") return "gitlink";
  if (mode === "120000") return "symlink";
  if (mode.startsWith("100")) return "file";
  if (mode === "040000") return "directory";
  return "other";
}
function fields(record: Buffer, count: number) {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(32, start);
    if (end < 0) throw new AppError("io_error", "Git status record is incomplete");
    parts.push(record.subarray(start, end).toString("ascii"));
    start = end + 1;
  }
  return { parts, path: record.subarray(start) };
}
export async function readStatus(
  repo: Repo,
  signal: AbortSignal,
  each: (entry: GitEntry) => void,
  onHeader?: (header: string) => void,
  onRaw?: (data: Buffer) => void,
) {
  let rename: { entry: Omit<GitEntry, "path" | "oldPath" | "pathError">; path: Buffer } | undefined;
  const reader = new NulRecords((record) => {
    if (rename) {
      each({ ...rename.entry, ...gitPath(rename.path, record) });
      rename = undefined;
      return;
    }
    if (record[0] === 35) {
      onHeader?.(utf8(record));
      return;
    }
    if (record[0] === 63) {
      each({
        ...gitPath(record.subarray(2)),
        types: { worktree: "other" },
        indexStatus: "?",
        worktreeStatus: "?",
        conflict: false,
      });
      return;
    }
    const type = String.fromCharCode(record[0] ?? 0);
    if (!["1", "2", "u"].includes(type))
      throw new AppError("io_error", "Unsupported Git status record");
    const { parts, path } = fields(record, type === "1" ? 8 : type === "2" ? 9 : 10);
    const xy = parts[1]!,
      sub = parts[2]!;
    const entry: Omit<GitEntry, "path" | "oldPath" | "pathError"> = {
      indexStatus: xy[0]!,
      worktreeStatus: xy[1]!,
      conflict: type === "u",
      types:
        type === "u"
          ? {
              base: modeType(parts[3]!),
              ours: modeType(parts[4]!),
              theirs: modeType(parts[5]!),
              worktree: modeType(parts[6]!),
            }
          : {
              head: modeType(parts[3]!),
              index: modeType(parts[4]!),
              worktree: modeType(parts[5]!),
            },
      ...(sub[0] === "S"
        ? {
            submodule: {
              commitChanged: sub[1] === "C",
              trackedDirty: sub[2] === "M",
              untrackedDirty: sub[3] === "U",
            },
          }
        : {}),
    };
    if (type === "2") rename = { entry, path };
    else each({ ...entry, ...gitPath(path) });
  });
  await git(
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
  if (rename) throw new AppError("io_error", "Git rename record is incomplete");
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
  let totalCount = 0,
    stagedCount = 0,
    hasConflicts = false,
    bytes = 2048,
    full = false;
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
      if (size + 2048 > agentLimits.resultBytes)
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
    operation: await readOperation(repo, before.head, hasConflicts, signal),
    truncated: nextOffset !== undefined,
  };
  while (Buffer.byteLength(JSON.stringify(result)) > agentLimits.resultBytes && entries.length) {
    entries.pop();
    result.nextOffset = offset + entries.length;
    result.truncated = true;
  }
  if (!entries.length && offset < totalCount)
    throw new AppError(
      "limit_exceeded",
      "A Git change and repository information exceed the size limit",
    );
  return result;
}
