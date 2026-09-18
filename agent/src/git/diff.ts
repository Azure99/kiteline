import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  limits,
  type DiffSummary,
  type GitDiff,
  type Repo,
} from "@kiteline/shared/protocol";
import { relativePath } from "../files/paths.js";
import { git, NulRecords, utf8 } from "./process.js";
import { diffOptions, readStatus } from "./status.js";

export interface RawChange {
  path: string;
  oldPath?: string;
  status: string;
  oldMode: string;
  newMode: string;
}
export function rawReader(each: (change: RawChange) => void) {
  let header: string[] | undefined, from: string | undefined;
  const reader = new NulRecords((record) => {
    if (!header) {
      header = record.toString("ascii").replace(/^:/, "").split(" ");
      return;
    }
    const path = utf8(record);
    const status = header[4]!;
    if (/^[RC]/.test(status) && from === undefined) {
      from = path;
      return;
    }
    each({
      path,
      ...(from === undefined ? {} : { oldPath: from }),
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
      if (header) throw new AppError("io_error", "Git raw diff 不完整");
    },
  };
}
export function numstatReader(each: (path: string, binary: boolean) => void) {
  let renamed = 0,
    binary = false;
  const reader = new NulRecords((record) => {
    if (renamed) {
      each(utf8(record), binary);
      renamed--;
      return;
    }
    const first = record.indexOf(9),
      second = record.indexOf(9, first + 1);
    if (first < 0 || second < 0) throw new AppError("io_error", "Git numstat 不完整");
    binary = record[0] === 45;
    if (second === record.length - 1) renamed = 2;
    else each(utf8(record.subarray(second + 1)), binary);
  });
  return {
    data: reader.data,
    end() {
      reader.end();
      if (renamed) throw new AppError("io_error", "Git numstat rename 不完整");
    },
  };
}
export function binaryPaths(bytes: Buffer) {
  const paths = new Set<string>();
  const reader = numstatReader((path, binary) => {
    if (binary) paths.add(path);
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
  // A literal Git path also selects descendants; exclude its directory form.
  return paths.flatMap((path) => [`:(top,literal)${path}`, `:(top,literal,exclude)${path}/`]);
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
      [...patchConfig, "--no-literal-pathspecs", ...args, "--patch", "--", ...leafPathspecs(group)],
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
    throw new AppError("conflict", "所选变化已不适用，请刷新");
  if (selected.indexStatus === "?") {
    const info = await lstat(join(repo.rootPath, path));
    if (!info.isFile() && !info.isSymbolicLink())
      throw new AppError("unsupported", "此项需进入目录或终端查看");
    const args = ["diff", "--no-index", ...diffOptions];
    const nums = await git(
      repo.rootPath,
      [...args, "--numstat", "-z", "--", "/dev/null", path],
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
      [...patchConfig, ...args, "--patch", "--", "/dev/null", path],
      signal,
      { allowedCodes: [0, 1], truncate: true },
    );
    return boundedDiff(patch.text, summary, patch.truncated);
  }
  const paths = side === "staged" && selected.oldPath ? [selected.oldPath, path] : [path];
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
  await git(repo.rootPath, [...args, "--raw", "--no-abbrev", "-z", "--", ...paths], signal, {
    onData: raw.data,
  });
  raw.end();
  if (!change) throw new AppError("conflict", "所选变化已不适用，请刷新");
  let binary = false;
  const nums = numstatReader((itemPath, isBinary) => {
    if (itemPath === path) binary = isBinary;
  });
  await git(repo.rootPath, [...args, "--numstat", "-z", "--", ...paths], signal, {
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
