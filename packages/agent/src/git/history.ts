import { agentLimits } from "../limits.js";
import { basename, dirname } from "node:path";
import {
  AppError,
  type Branch,
  type Commit,
  type CommitFile,
  type CommitFiles,
  type DiffSummary,
  type GitHistory,
  type GitPath,
  type Repo,
} from "@kiteline/shared/protocol";
import { relativePath } from "../files/paths.js";
import { boundedDiff, numstatReader, selectedPatch, rawReader, type RawChange } from "./diff.js";
import { gitRead } from "./process.js";
import { commandLine, gitPathKey, NulRecords, utf8 } from "./format.js";
import { diffOptions, emptyTree, headIdentity } from "./observe.js";

// Conservative space for each page's fields outside its item array.
const historyEnvelopeReserveBytes = 256;
const commitFilesEnvelopeReserveBytes = 512;
// Reserve the separator and both line counts populated by numstat after selection.
const commitFileStatisticsReserveBytes = 65;
const logFields: [oid: string, parents: string, author: string, time: string, subject: string] = [
  "%H",
  "%P",
  "%an",
  "%aI",
  "%s",
];
const branchRefPrefix = "refs/heads/";

export function parseCommitOid(oid: string) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
    throw new AppError("invalid_argument", "A full commit OID is required");
  return oid;
}
export async function resolveCommitOid(repo: Repo, oid: string, signal: AbortSignal) {
  const actual = commandLine(
    (await gitRead(repo.rootPath, ["rev-parse", "--verify", `${oid}^{commit}`], signal)).bytes,
  );
  if (actual !== oid) throw new AppError("invalid_argument", "OID is not a commit object");
  return actual;
}
export async function commitMessage(repo: Repo, oid: string, signal: AbortSignal) {
  const commit = await resolveCommitOid(repo, parseCommitOid(oid), signal);
  const output = await gitRead(
    repo.rootPath,
    [
      "show",
      "--no-show-signature",
      "--no-color",
      "--no-patch",
      "--encoding=UTF-8",
      "--format=format:%B",
      commit,
      "--",
    ],
    signal,
  );
  const result = { message: utf8(output.bytes) };
  if (Buffer.byteLength(JSON.stringify(result)) > agentLimits.resultBytes)
    throw new AppError("limit_exceeded", "Commit message exceeds the size limit");
  return result;
}
export async function history(
  repo: Repo,
  anchor: string | undefined,
  offset: number,
  signal: AbortSignal,
): Promise<GitHistory> {
  anchor ??= (await headIdentity(repo.rootPath, signal)).oid ?? undefined;
  if (!anchor) return { commits: [] };
  const anchorOid = await resolveCommitOid(repo, parseCommitOid(anchor), signal);
  const commits: Commit[] = [];
  let fields: string[] = [];
  let count = 0;
  let bytes = historyEnvelopeReserveBytes;
  let full = false;
  const reader = new NulRecords((record) => {
    fields.push(utf8(record));
    if (fields.length !== logFields.length) return;
    const [oid, parents, author, time, subject] = fields as typeof logFields;
    fields = [];
    const commit = { oid, parents: parents ? parents.split(" ") : [], author, time, subject };
    const size = Buffer.byteLength(JSON.stringify(commit)) + 1;
    if (size + historyEnvelopeReserveBytes > agentLimits.resultBytes)
      throw new AppError("limit_exceeded", "A commit message exceeds the size limit");
    count++;
    if (
      full ||
      commits.length >= agentLimits.listPageEntries ||
      bytes + size > agentLimits.resultBytes
    ) {
      full = true;
      return;
    }
    bytes += size;
    commits.push(commit);
  });
  await gitRead(
    repo.rootPath,
    [
      "log",
      "--no-show-signature",
      "--no-color",
      "--encoding=UTF-8",
      "-z",
      `--format=${logFields.join("%x00")}`,
      `--max-count=${agentLimits.listPageEntries + 1}`,
      `--skip=${offset}`,
      anchorOid,
      "--",
    ],
    signal,
    { onData: reader.data },
  );
  reader.end();
  if (fields.length) throw new AppError("io_error", "Git commit record is incomplete");
  return {
    commits,
    anchorOid,
    ...(count > commits.length ? { nextOffset: offset + commits.length } : {}),
  };
}
async function comparison(
  repo: Repo,
  oid: string,
  selectedParent: string | undefined,
  signal: AbortSignal,
) {
  const commit = await resolveCommitOid(repo, parseCommitOid(oid), signal);
  const value = commandLine(
    (
      await gitRead(
        repo.rootPath,
        ["show", "--no-show-signature", "--no-color", "--no-patch", "--format=%P", commit, "--"],
        signal,
      )
    ).bytes,
  );
  const parents = value ? value.split(" ") : [];
  if (selectedParent !== undefined && !parents.includes(selectedParent))
    throw new AppError("invalid_argument", "Selected OID is not a parent of this commit");
  if (parents.length > 1 && !selectedParent)
    throw new AppError("invalid_argument", "Select a parent of the merge commit");
  const parentOid = selectedParent ?? parents[0];
  const base = parentOid ?? (await emptyTree(repo.rootPath, signal));
  return { commit, base, parentOid };
}
async function changes(
  repo: Repo,
  base: string,
  commit: string,
  signal: AbortSignal,
  each: (change: RawChange) => void,
) {
  const reader = rawReader(each);
  await gitRead(
    repo.rootPath,
    ["diff", ...diffOptions, "--find-renames", "--raw", "--no-abbrev", "-z", base, commit, "--"],
    signal,
    { onData: reader.data },
  );
  reader.end();
}
async function statistics(
  repo: Repo,
  base: string,
  commit: string,
  paths: GitPath[],
  signal: AbortSignal,
) {
  const result = new Map<string, { binary: boolean; additions?: number; deletions?: number }>();
  const wanted = new Set(paths.map(gitPathKey));
  const reader = numstatReader((path, isBinary, lines) => {
    const key = gitPathKey(path);
    if (wanted.has(key)) result.set(key, { binary: isBinary, ...lines });
  });
  await gitRead(
    repo.rootPath,
    ["diff", ...diffOptions, "--find-renames", "--numstat", "-z", base, commit, "--"],
    signal,
    { onData: reader.data },
  );
  reader.end();
  return result;
}
export async function commitFiles(
  repo: Repo,
  oid: string,
  parent: string | undefined,
  offset: number,
  signal: AbortSignal,
): Promise<CommitFiles> {
  const { commit, base, parentOid } = await comparison(repo, oid, parent, signal);
  const files: CommitFile[] = [];
  let count = 0;
  let bytes = commitFilesEnvelopeReserveBytes;
  let full = false;
  await changes(repo, base, commit, signal, (change) => {
    const item: CommitFile = {
      ...(change.path === undefined
        ? { pathError: change.pathError }
        : { path: change.path, oldPath: change.oldPath }),
      status: change.status,
      binary: false,
    };
    const size = Buffer.byteLength(JSON.stringify(item)) + commitFileStatisticsReserveBytes;
    if (size + commitFilesEnvelopeReserveBytes > agentLimits.resultBytes)
      throw new AppError("limit_exceeded", "A commit file entry exceeds the size limit");
    if (count++ < offset || full) return;
    if (files.length >= agentLimits.listPageEntries || bytes + size > agentLimits.resultBytes) {
      full = true;
      return;
    }
    bytes += size;
    files.push(item);
  });
  const stats = await statistics(repo, base, commit, files, signal);
  for (const item of files) Object.assign(item, stats.get(gitPathKey(item)));
  signal.throwIfAborted();
  const nextOffset = offset + files.length;
  return { parentOid, files, ...(nextOffset < count ? { nextOffset } : {}) };
}
export async function commitDiff(
  repo: Repo,
  oid: string,
  parent: string | undefined,
  path: string,
  signal: AbortSignal,
) {
  path = relativePath(path);
  const { commit, base } = await comparison(repo, oid, parent, signal);
  let change: RawChange | undefined;
  await changes(repo, base, commit, signal, (item) => {
    if (item.path === path) change = item;
  });
  if (change?.path === undefined)
    throw new AppError("not_found", "Selected file change is not present in this commit");
  const stats = await statistics(repo, base, commit, [change], signal);
  const summary: DiffSummary = {
    path,
    oldPath: change.oldPath,
    status: change.status,
    binary: stats.get(gitPathKey(change))?.binary ?? false,
    ...(change.oldMode !== "000000" ? { oldMode: change.oldMode } : {}),
    ...(change.newMode !== "000000" ? { newMode: change.newMode } : {}),
  };
  const patch = await selectedPatch(
    repo,
    ["diff", ...diffOptions, "--find-renames", base, commit],
    change.oldPath ? [change.oldPath, path] : [path],
    signal,
  );
  return boundedDiff(patch.text, summary, patch.truncated);
}
export async function branches(repo: Repo, signal: AbortSignal) {
  const head = await headIdentity(repo.rootPath, signal);
  const output = await gitRead(
    repo.rootPath,
    [
      "for-each-ref",
      "--color=never",
      "--format=%(refname)%00%(objectname)%00%(worktreepath)%00",
      branchRefPrefix,
    ],
    signal,
  );
  // Git appends LF after our final %00. Worktree paths may themselves contain LF.
  const records = utf8(output.bytes).split("\0\n").slice(0, -1);
  const result: Branch[] = records.map((record) => {
    const [ref, oid, worktreePath] = record.split("\0") as [string, string, string];
    return {
      name: ref.slice(branchRefPrefix.length),
      oid,
      current: ref === head.symbolicRef,
      worktreePath: worktreePath || undefined,
    };
  });
  // Git also reports the bare main entry as a worktree path.
  const mainPath = basename(repo.commonDir) === ".git" ? dirname(repo.commonDir) : repo.commonDir;
  const bareRoot =
    result.some((branch) => branch.worktreePath === mainPath) &&
    commandLine(
      (
        await gitRead(
          repo.rootPath,
          [`--git-dir=${repo.commonDir}`, "rev-parse", "--is-bare-repository"],
          signal,
        )
      ).bytes,
    ) === "true";
  if (bareRoot)
    for (const branch of result)
      if (branch.worktreePath === mainPath) branch.worktreePath = undefined;
  if (Buffer.byteLength(JSON.stringify({ branches: result })) > agentLimits.resultBytes)
    throw new AppError("limit_exceeded", "Branch list exceeds the size limit");
  return { branches: result };
}
