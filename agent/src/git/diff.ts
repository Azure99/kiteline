import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  limits,
  type DiffSummary,
  type GitDiff,
  type GitPath,
  type Repo,
} from "@kiteline/shared/protocol";
import { relativePath } from "../files/paths.js";
import { git, gitPath, gitPathKey, NulRecords } from "./process.js";
import { diffOptions, readStatus } from "./status.js";

export type RawChange = GitPath & {
  status: string;
  oldMode: string;
  newMode: string;
};
export function rawReader(each: (change: RawChange) => void) {
  let header: string[] | undefined, from: Buffer | undefined;
  const reader = new NulRecords((record) => {
    if (!header) {
      header = record.toString("ascii").replace(/^:/, "").split(" ");
      return;
    }
    const status = header[4]!;
    if (status.startsWith("R") && from === undefined) {
      from = record;
      return;
    }
    each({
      ...gitPath(record, from),
      status: status[0]!,
      oldMode: header[0]!,
      newMode: header[1]!,
    });
    header = undefined;
    from = undefined;
  });
  return {
    data: reader.data,
    end() {
      reader.end();
      if (header) throw new AppError("io_error", "Git raw diff is incomplete");
    },
  };
}
export function numstatReader(each: (path: GitPath, binary: boolean) => void) {
  let renamed = 0,
    binary = false;
  let from: Buffer | undefined;
  const reader = new NulRecords((record) => {
    if (renamed) {
      if (renamed === 2) from = record;
      else {
        each(gitPath(record, from), binary);
        from = undefined;
      }
      renamed--;
      return;
    }
    const first = record.indexOf(9),
      second = record.indexOf(9, first + 1);
    if (first < 0 || second < 0) throw new AppError("io_error", "Git numstat is incomplete");
    binary = record[0] === 45;
    if (second === record.length - 1) renamed = 2;
    else each(gitPath(record.subarray(second + 1)), binary);
  });
  return {
    data: reader.data,
    end() {
      reader.end();
      if (renamed) throw new AppError("io_error", "Git numstat rename record is incomplete");
    },
  };
}
export function binaryPaths(bytes: Buffer) {
  const paths = new Set<string>();
  const reader = numstatReader((path, binary) => {
    if (binary) paths.add(gitPathKey(path));
  });
  reader.data(bytes);
  reader.end();
  return paths;
}
export function boundedDiff(patch: string, summary: DiffSummary, truncated: boolean): GitDiff {
  const budget = limits.resultBytes - Buffer.byteLength(JSON.stringify(summary)) - 256;
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
export const patchConfig = ["-c", "core.quotePath=true", "-c", "diff.suppressBlankEmpty=false"];
function leafPathspecs(paths: string[]) {
  return paths.flatMap((path) => {
    const escaped = path.replace(/[\\*?[\]]/g, "\\$&");
    // Git 2.23 otherwise treats the plain prefix as the gitlink itself.
    const prefix = escaped.startsWith("\\") ? escaped : `\\${escaped}`;
    return [`:(top,literal)${path}`, `:(top,glob,exclude)${prefix}/**`];
  });
}
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
    remaining = limits.resultBytes,
    truncated = false;
  for (const group of groups) {
    const result = await git(
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
    const nums = await git(
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
    const patch = await git(
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
  const pathspecs = paths.map((path) => `:(top,literal)${path}`);
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
  await git(repo.rootPath, [...args, "--raw", "--no-abbrev", "-z", "--", ...pathspecs], signal, {
    onData: raw.data,
  });
  raw.end();
  if (change?.path === undefined)
    throw new AppError("conflict", "Selected change no longer applies; refresh", {
      reason: "change_unavailable",
    });
  let binary = false;
  const nums = numstatReader((item, isBinary) => {
    if (item.path === path) binary = isBinary;
  });
  await git(repo.rootPath, [...args, "--numstat", "-z", "--", ...pathspecs], signal, {
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
