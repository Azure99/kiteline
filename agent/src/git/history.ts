import { randomUUID } from "node:crypto";
import {
  AppError,
  limits,
  type Branch,
  type Commit,
  type CommitFile,
  type CommitFiles,
  type DiffSummary,
  type GitHistory,
  type Repo,
} from "@kiteline/shared/protocol";
import type { CursorBudget } from "../cursor-budget.js";
import { relativePath } from "../files/paths.js";
import { boundedDiff, numstatReader, selectedPatch, rawReader, type RawChange } from "./diff.js";
import { commandLine, git, NulRecords, utf8 } from "./process.js";
import { diffOptions, headIdentity } from "./status.js";

async function commitOid(repo: Repo, oid: string, signal: AbortSignal) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
    throw new AppError("invalid_argument", "需要完整提交 OID");
  const actual = commandLine(
    (await git(repo.rootPath, ["rev-parse", "--verify", `${oid}^{commit}`], signal)).bytes,
  );
  if (actual !== oid) throw new AppError("invalid_argument", "OID 不是提交对象");
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
    if (size + 256 > limits.resultBytes)
      throw new AppError("limit_exceeded", "单条提交信息超过容量");
    count++;
    if (full || commits.length >= limits.listPageEntries || bytes + size > limits.resultBytes) {
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
      `--max-count=${limits.listPageEntries + 1}`,
      `--skip=${offset}`,
      anchorOid,
      "--",
    ],
    signal,
    { onData: reader.data },
  );
  reader.end();
  if (fields.length) throw new AppError("io_error", "Git 提交记录不完整");
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
    throw new AppError("invalid_argument", "所选 OID 不是该提交的父项");
  if (parents.length > 1 && !selectedParent)
    throw new AppError("invalid_argument", "请选择合并提交的父项");
  const parentOid = selectedParent ?? parents[0];
  const base =
    parentOid ??
    commandLine(
      (await git(repo.rootPath, ["hash-object", "-t", "tree", "--stdin"], signal, { input: "" }))
        .bytes,
    );
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
  paths: string[],
  signal: AbortSignal,
) {
  const result = new Set<string>();
  const wanted = new Set(paths);
  const reader = numstatReader((path, isBinary) => {
    if (isBinary && wanted.has(path)) result.add(path);
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
interface Cursor {
  workspaceId: string;
  repoId: string;
  commit: string;
  parentOid?: string;
  prepared: boolean;
  offset: number;
  busy: boolean;
  timer: NodeJS.Timeout;
  release: () => void;
  controller: AbortController;
}
export class GitHistoryReads {
  private cursors = new Map<string, Cursor>();
  constructor(private budget: CursorBudget) {}
  async files(
    workspaceId: string,
    repo: Repo,
    oid: string,
    parent: string | undefined,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<CommitFiles> {
    const id = token ?? randomUUID();
    let cursor = this.cursors.get(id);
    if (
      token &&
      (!cursor ||
        cursor.workspaceId !== workspaceId ||
        cursor.repoId !== repo.id ||
        cursor.commit !== oid)
    )
      throw new AppError("conflict", "提交文件列表已过期，请刷新");
    if (!cursor) {
      cursor = {
        workspaceId,
        repoId: repo.id,
        commit: oid,
        prepared: false,
        offset: 0,
        busy: false,
        release: this.budget.reserve(),
        controller: new AbortController(),
        timer: setTimeout(() => this.closeCursor(id), limits.cursorLifetime),
      };
      this.cursors.set(id, cursor);
    }
    if (cursor.busy) throw new AppError("busy", "提交文件列表正在读取");
    cursor.busy = true;
    signal = AbortSignal.any([signal, cursor.controller.signal]);
    const items: CommitFile[] = [];
    let count = 0,
      bytes = 512,
      full = false;
    try {
      const { commit, base, parentOid } = await comparison(repo, oid, parent, signal);
      if (cursor.prepared && cursor.parentOid !== parentOid)
        throw new AppError("conflict", "提交文件列表的父项已变化，请刷新");
      cursor.parentOid = parentOid;
      cursor.prepared = true;
      await changes(repo, base, commit, signal, (change) => {
        const item = {
          path: change.path,
          oldPath: change.oldPath,
          status: change.status,
          binary: false,
        };
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (size + 512 > limits.resultBytes)
          throw new AppError("limit_exceeded", "单个提交文件超过容量");
        if (count++ < cursor!.offset || full) return;
        if (items.length >= limits.listPageEntries || bytes + size > limits.resultBytes) {
          full = true;
          return;
        }
        bytes += size;
        items.push(item);
      });
      const binaries = await binary(
        repo,
        base,
        commit,
        items.map((item) => item.path),
        signal,
      );
      for (const item of items) item.binary = binaries.has(item.path);
      signal.throwIfAborted();
      cursor.offset += items.length;
      const more = cursor.offset < count;
      if (more) cursor.timer.refresh();
      else this.closeCursor(id);
      return { parentOid, files: { items, truncated: more, ...(more ? { nextCursor: id } : {}) } };
    } catch (error) {
      this.closeCursor(id);
      throw error;
    } finally {
      cursor.busy = false;
    }
  }
  private closeCursor(id: string) {
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    this.cursors.delete(id);
    clearTimeout(cursor.timer);
    cursor.release();
    cursor.controller.abort(new AppError("cancelled", "提交文件读取已结束"));
  }
  retain(workspaceIds: Set<string>) {
    for (const [id, cursor] of this.cursors)
      if (!workspaceIds.has(cursor.workspaceId)) this.closeCursor(id);
  }
  close() {
    for (const id of this.cursors.keys()) this.closeCursor(id);
  }
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
  if (!change) throw new AppError("not_found", "该提交中没有所选文件变化");
  const binaries = await binary(repo, base, commit, [path], signal);
  const summary: DiffSummary = {
    path,
    oldPath: change.oldPath,
    status: change.status,
    binary: binaries.has(path),
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
  const occupied = new Map<string, string>();
  let path = "";
  const worktrees = new NulRecords((record) => {
    const field = utf8(record);
    if (field.startsWith("worktree ")) path = field.slice(9);
    else if (field.startsWith("branch ")) occupied.set(field.slice(7), path);
  });
  await git(repo.rootPath, ["worktree", "list", "--porcelain", "-z"], signal, {
    onData: worktrees.data,
  });
  worktrees.end();
  const output = await git(
    repo.rootPath,
    ["for-each-ref", "--color=never", "--format=%(refname)%00%(objectname)%00", "refs/heads/"],
    signal,
  );
  const fields = utf8(output.bytes).split("\0");
  const result: Branch[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const ref = fields[i]!.replace(/^\n/, "");
    result.push({
      name: ref.slice(11),
      oid: fields[i + 1]!,
      current: ref === head.symbolicRef,
      worktreePath: occupied.get(ref),
    });
  }
  if (Buffer.byteLength(JSON.stringify({ branches: result })) > limits.resultBytes)
    throw new AppError("limit_exceeded", "分支列表超过容量");
  return { branches: result };
}
