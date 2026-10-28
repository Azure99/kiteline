import { agentLimits } from "../limits.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type DiffSummary,
  type GitDiff,
  type GitPath,
  type Repo,
} from "@kiteline/shared/protocol";
import { relativePath } from "../files/paths.js";
import { gitRead } from "./process.js";
import { gitPath, gitPathKey, leafPathspecs, literalPathspec, NulRecords } from "./format.js";
import { diffOptions } from "./observe.js";
import { readStatus } from "./status.js";

export type RawChange = GitPath & {
  status: string;
  oldMode: string;
  newMode: string;
};
export function rawReader(each: (change: RawChange) => void) {
  let header: { oldMode: string; newMode: string; status: string } | undefined;
  let renameSource: Buffer | undefined;
  const reader = new NulRecords((record) => {
    if (!header) {
      // :oldMode newMode oldOid newOid status, followed by NUL pathname records.
      const [oldMode, newMode, , , status] = record.toString("ascii").slice(1).split(" ");
      header = { oldMode: oldMode!, newMode: newMode!, status: status! };
      return;
    }
    if (header.status.startsWith("R") && renameSource === undefined) {
      renameSource = record;
      return;
    }
    each({
      ...gitPath(record, renameSource),
      status: header.status[0]!,
      oldMode: header.oldMode,
      newMode: header.newMode,
    });
    header = undefined;
    renameSource = undefined;
  });
  return {
    data: reader.data,
    end() {
      reader.end();
      if (header) throw new AppError("io_error", "Git raw diff is incomplete");
    },
  };
}
export function numstatReader(
  each: (path: GitPath, binary: boolean, lines?: { additions: number; deletions: number }) => void,
) {
  let renamePath: "source" | "target" | undefined;
  let binary = false;
  let lines: { additions: number; deletions: number } | undefined;
  let renameSource: Buffer | undefined;
  const reader = new NulRecords((record) => {
    if (renamePath === "source") {
      renameSource = record;
      renamePath = "target";
      return;
    }
    if (renamePath === "target") {
      each(gitPath(record, renameSource), binary, lines);
      renameSource = undefined;
      renamePath = undefined;
      return;
    }
    const additionsEnd = record.indexOf(9);
    const deletionsEnd = record.indexOf(9, additionsEnd + 1);
    if (additionsEnd < 0 || deletionsEnd < 0)
      throw new AppError("io_error", "Git numstat is incomplete");
    binary = record[0] === 45;
    lines = binary
      ? undefined
      : {
          additions: Number(record.subarray(0, additionsEnd).toString("ascii")),
          deletions: Number(record.subarray(additionsEnd + 1, deletionsEnd).toString("ascii")),
        };
    // An empty pathname introduces separate source and target NUL records.
    if (deletionsEnd === record.length - 1) renamePath = "source";
    else each(gitPath(record.subarray(deletionsEnd + 1)), binary, lines);
  });
  return {
    data: reader.data,
    end() {
      reader.end();
      if (renamePath) throw new AppError("io_error", "Git numstat rename record is incomplete");
    },
  };
}
function binaryPaths(bytes: Buffer) {
  const paths = new Set<string>();
  const reader = numstatReader((path, binary) => {
    if (binary) paths.add(gitPathKey(path));
  });
  reader.data(bytes);
  reader.end();
  return paths;
}
export function boundedDiff(patch: string, summary: DiffSummary, truncated: boolean): GitDiff {
  const budget = agentLimits.resultBytes - Buffer.byteLength(JSON.stringify(summary)) - 256;
  if (Buffer.byteLength(JSON.stringify(patch)) > budget) {
    let low = 0,
      high = patch.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(patch.slice(0, mid))) <= budget) low = mid;
      else high = mid - 1;
    }
    patch = patch.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
    truncated = true;
  }
  return { patch, summary, truncated };
}
// The parser needs the context prefix even on blank lines to avoid silently losing them.
const patchConfig = ["-c", "core.quotePath=true", "-c", "diff.suppressBlankEmpty=false"];
export async function selectedPatch(
  repo: Repo,
  args: string[],
  paths: string[],
  signal: AbortSignal,
) {
  // An ancestor rename must use separate D/A blocks: its exclusion also hides the other end.
  const overlapping = paths.some((path) => paths.some((other) => path.startsWith(`${other}/`)));
  const groups = overlapping ? paths.map((path) => [path]) : [paths];
  let patch = "",
    remaining = agentLimits.resultBytes,
    truncated = false;
  for (const group of groups) {
    const result = await gitRead(
      repo.rootPath,
      [...patchConfig, ...args, "--patch", "--", ...leafPathspecs(group)],
      signal,
      { truncate: true, maxBytes: remaining },
    );
    patch += result.text;
    remaining -= result.bytes.length;
    truncated ||= result.truncated;
    if (truncated) break;
  }
  return { text: patch, truncated };
}
export async function workingDiff(
  repo: Repo,
  path: string,
  side: "worktree" | "staged",
  signal: AbortSignal,
): Promise<GitDiff> {
  path = relativePath(path);
  let selected: Parameters<Parameters<typeof readStatus>[2]>[0] | undefined;
  await readStatus(repo, signal, (entry) => {
    if (entry.path === path) selected = entry;
  });
  if (
    !selected ||
    (side === "staged" && [".", "?"].includes(selected.indexStatus)) ||
    (side === "worktree" && selected.worktreeStatus === ".")
  )
    throw new AppError("conflict", "Selected change no longer applies; refresh", {
      reason: "change_unavailable",
    });
  if (selected.indexStatus === "?") {
    const info = await lstat(join(repo.rootPath, path));
    if (!info.isFile() && !info.isSymbolicLink())
      throw new AppError(
        "unsupported",
        "Open the directory or use the terminal to inspect this item",
      );
    const args = ["diff", "--no-index", ...diffOptions];
    const nums = await gitRead(
      repo.rootPath,
      [...args, "--numstat", "-z", "--", "/dev/null", `./${path}`],
      signal,
      { allowedCodes: [0, 1] },
    );
    const summary: DiffSummary = {
      path,
      status: "?",
      binary: binaryPaths(nums.bytes).size > 0,
      newMode: info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644",
    };
    const patch = await gitRead(
      repo.rootPath,
      [...patchConfig, ...args, "--patch", "--", "/dev/null", `./${path}`],
      signal,
      { allowedCodes: [0, 1], truncate: true },
    );
    return boundedDiff(patch.text, summary, patch.truncated);
  }
  const paths =
    side === "staged" && selected.indexStatus === "R" && selected.oldPath
      ? [selected.oldPath, path]
      : [path];
  const pathspecs = paths.map(literalPathspec);
  const args = [
    "diff",
    ...(side === "staged" ? ["--cached"] : []),
    "--find-renames",
    ...diffOptions,
  ];
  let change: RawChange | undefined;
  const raw = rawReader((item) => {
    if (item.path === path) change = item;
  });
  await gitRead(
    repo.rootPath,
    [...args, "--raw", "--no-abbrev", "-z", "--", ...pathspecs],
    signal,
    {
      onData: raw.data,
    },
  );
  raw.end();
  if (change?.path === undefined)
    throw new AppError("conflict", "Selected change no longer applies; refresh", {
      reason: "change_unavailable",
    });
  let binary = false;
  const nums = numstatReader((item, isBinary) => {
    if (item.path === path) binary = isBinary;
  });
  await gitRead(repo.rootPath, [...args, "--numstat", "-z", "--", ...pathspecs], signal, {
    onData: nums.data,
  });
  nums.end();
  const summary: DiffSummary = {
    path: change.path,
    oldPath: change.oldPath,
    status: change.status,
    binary,
    ...(change.oldMode === "000000" ? {} : { oldMode: change.oldMode }),
    ...(change.newMode === "000000" ? {} : { newMode: change.newMode }),
  };
  const patch = await selectedPatch(repo, args, paths, signal);
  return boundedDiff(patch.text, summary, patch.truncated);
}
