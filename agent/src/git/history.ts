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
import { commandLine, git, gitPathKey, NulRecords, utf8 } from "./process.js";
import { diffOptions, emptyTree, headIdentity } from "./observe.js";

export async function commitOid(repo: Repo, oid: string, signal: AbortSignal) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
    throw new AppError("invalid_argument", "A full commit OID is required");
  const actual = commandLine(
    (await git(repo.rootPath, ["rev-parse", "--verify", `${oid}^{commit}`], signal)).bytes,
  );
  if (actual !== oid) throw new AppError("invalid_argument", "OID is not a commit object");
  return actual;
}
export async function history(
  repo: Repo,
  anchor: string | undefined,
  offset: number,
  signal: AbortSignal,
): Promise<GitHistory> {
  anchor ??= (await headIdentity(repo.rootPath, signal)).oid ?? undefined;
  if (!anchor) return { commits: [] };
  const anchorOid = await commitOid(repo, anchor, signal);
  const commits: Commit[] = [];
  let fields: string[] = [],
    count = 0,
    bytes = 256,
    full = false;
  const reader = new NulRecords((record) => {
    fields.push(utf8(record));
    if (fields.length !== 5) return;
    const [oid, parents, author, time, subject] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    fields = [];
    const commit = { oid, parents: parents ? parents.split(" ") : [], author, time, subject };
    const size = Buffer.byteLength(JSON.stringify(commit)) + 1;
    if (size + 256 > agentLimits.resultBytes)
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
  await git(
    repo.rootPath,
    [
      "log",
      "--no-show-signature",
      "--no-color",
      "--encoding=UTF-8",
      "-z",
      "--format=%H%x00%P%x00%an%x00%aI%x00%s",
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
  const commit = await commitOid(repo, oid, signal);
  const value = commandLine(
    (
      await git(
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
  await git(
    repo.rootPath,
    ["diff", ...diffOptions, "--find-renames", "--raw", "--no-abbrev", "-z", base, commit, "--"],
    signal,
    { onData: reader.data },
  );
  reader.end();
}
async function binary(
  repo: Repo,
  base: string,
  commit: string,
  paths: GitPath[],
  signal: AbortSignal,
) {
  const result = new Set<string>();
  const wanted = new Set(paths.map(gitPathKey));
  const reader = numstatReader((path, isBinary) => {
    const key = gitPathKey(path);
    if (isBinary && wanted.has(key)) result.add(key);
  });
  await git(
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
  let count = 0,
    bytes = 512,
    full = false;
  await changes(repo, base, commit, signal, (change) => {
    const item: CommitFile = {
      ...(change.path === undefined
        ? { pathError: change.pathError }
        : { path: change.path, oldPath: change.oldPath }),
      status: change.status,
      binary: false,
    };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size + 512 > agentLimits.resultBytes)
      throw new AppError("limit_exceeded", "A commit file entry exceeds the size limit");
    if (count++ < offset || full) return;
    if (files.length >= agentLimits.listPageEntries || bytes + size > agentLimits.resultBytes) {
      full = true;
      return;
    }
    bytes += size;
    files.push(item);
  });
  const binaries = await binary(repo, base, commit, files, signal);
  for (const item of files) item.binary = binaries.has(gitPathKey(item));
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
  const binaries = await binary(repo, base, commit, [change], signal);
  const summary: DiffSummary = {
    path,
    oldPath: change.oldPath,
    status: change.status,
    binary: binaries.has(gitPathKey(change)),
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
  const output = await git(
    repo.rootPath,
    [
      "for-each-ref",
      "--color=never",
      "--format=%(refname)%00%(objectname)%00%(worktreepath)%00",
      "refs/heads/",
    ],
    signal,
  );
  const fields = utf8(output.bytes).split("\0");
  // Git also reports the bare main entry as a worktree path.
  const mainPath = basename(repo.commonDir) === ".git" ? dirname(repo.commonDir) : repo.commonDir;
  const bareRoot =
    fields.includes(mainPath) &&
    commandLine(
      (
        await git(
          repo.rootPath,
          [`--git-dir=${repo.commonDir}`, "rev-parse", "--is-bare-repository"],
          signal,
        )
      ).bytes,
    ) === "true";
  const result: Branch[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const ref = fields[i]!.replace(/^\n/, "");
    result.push({
      name: ref.slice(11),
      oid: fields[i + 1]!,
      current: ref === head.symbolicRef,
      worktreePath: bareRoot && fields[i + 2] === mainPath ? undefined : fields[i + 2] || undefined,
    });
  }
  if (Buffer.byteLength(JSON.stringify({ branches: result })) > agentLimits.resultBytes)
    throw new AppError("limit_exceeded", "Branch list exceeds the size limit");
  return { branches: result };
}
