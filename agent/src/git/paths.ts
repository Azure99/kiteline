import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  asError,
  limits,
  OperationError,
  type DiscardScope,
  type GitEntry,
  type GitReview,
  type Repo,
} from "@kiteline/shared/protocol";
import { relativePath } from "../files/paths.js";
import { git, NulRecords, utf8 } from "./process.js";
import { headIdentity, modeType, observeIndex, readStatus } from "./status.js";

interface Leaf {
  mode: string;
  oid: string;
  stage: number;
}
const leaf = (item?: Leaf) => item && ["file", "symlink", "gitlink"].includes(modeType(item.mode));
const nul = (paths: string[]) => Buffer.from(paths.join("\0") + "\0");

export function gitPaths(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > limits.listPageEntries * 2)
    throw new AppError("invalid_argument", "Select files from the current page");
  const paths = [...new Set(value.map(relativePath))];
  if (Buffer.byteLength(JSON.stringify({ changedPaths: paths })) > limits.resultBytes)
    throw new AppError(
      "limit_exceeded",
      "Selected paths exceed the size limit; select fewer items",
    );
  if (paths.some((path) => path === "." || path.split("/").includes(".git")))
    throw new AppError("invalid_argument", "Cannot operate on the repository root or Git metadata");
  return paths.sort();
}
export function discardScope(value: unknown): DiscardScope {
  if (value !== "worktree" && value !== "all")
    throw new AppError("invalid_argument", "Invalid discard scope");
  return value;
}
class Blockers {
  paths = new Set<string>();
  truncated = false;
  private bytes = 0;
  add(path: string) {
    if (this.paths.has(path)) return;
    const size = Buffer.byteLength(JSON.stringify(path)) + 1;
    if (
      this.paths.size >= limits.listPageEntries ||
      this.bytes + size > limits.resultBytes - 4096
    ) {
      this.truncated = true;
      return;
    }
    this.paths.add(path);
    this.bytes += size;
  }
  check(message: string) {
    if (this.paths.size || this.truncated)
      throw new AppError("conflict", message, {
        blockedPaths: [...this.paths],
        truncated: this.truncated,
      });
  }
}
async function indexRecords(
  repo: Repo,
  signal: AbortSignal,
  each: (path: string, entry: Leaf) => void,
) {
  const reader = new NulRecords((record) => {
    const tab = record.indexOf(9);
    const [mode, oid, stage] = record.subarray(0, tab).toString("ascii").split(" ");
    each(utf8(record.subarray(tab + 1)), { mode: mode!, oid: oid!, stage: Number(stage) });
  });
  await git(repo.rootPath, ["ls-files", "--stage", "-z"], signal, { onData: reader.data });
  reader.end();
}
async function leaves(repo: Repo, paths: string[], source: "HEAD" | "index", signal: AbortSignal) {
  const wanted = new Set(paths);
  const found = new Map<string, Leaf>();
  if (source === "index") {
    await indexRecords(repo, signal, (path, entry) => {
      if (wanted.has(path) && entry.stage === 0) found.set(path, entry);
    });
  } else if ((await headIdentity(repo.rootPath, signal)).oid) {
    const reader = new NulRecords((record) => {
      const tab = record.indexOf(9);
      const path = utf8(record.subarray(tab + 1));
      const [mode, , oid] = record.subarray(0, tab).toString("ascii").split(" ");
      if (wanted.has(path)) found.set(path, { mode: mode!, oid: oid!, stage: 0 });
    });
    await git(
      repo.rootPath,
      [
        "ls-tree",
        "-z",
        "--full-tree",
        "HEAD",
        "--",
        ...paths.map((path) => `:(top,literal)${path}`),
      ],
      signal,
      { onData: reader.data },
    );
    reader.end();
  }
  return found;
}
async function selectedStatus(
  repo: Repo,
  paths: string[],
  signal: AbortSignal,
  aliases?: "index" | "all",
) {
  const wanted = new Set(paths);
  const found = new Map<string, GitEntry>();
  const renamed = new Map<string, GitEntry>();
  await readStatus(repo, signal, (entry) => {
    if (wanted.has(entry.path)) found.set(entry.path, entry);
    if (
      aliases &&
      entry.oldPath &&
      (entry.indexStatus === "R" || (aliases === "all" && entry.worktreeStatus === "R")) &&
      wanted.has(entry.oldPath)
    )
      renamed.set(entry.oldPath, entry);
  });
  for (const [path, entry] of renamed)
    if (!found.has(path) || (aliases === "index" && found.get(path)?.indexStatus === "?"))
      found.set(path, entry);
  return found;
}
async function checkIndex(repo: Repo, add: string[], remove: string[], signal: AbortSignal) {
  const removed = new Set(remove);
  const targets = new Set(add);
  const ancestors = new Set<string>();
  for (const path of add)
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1))
      ancestors.add(path.slice(0, slash));
  const blocked = new Blockers();
  await indexRecords(repo, signal, (path) => {
    if (removed.has(path)) return;
    if (ancestors.has(path)) {
      blocked.add(path);
      return;
    }
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1))
      if (targets.has(path.slice(0, slash))) {
        blocked.add(path);
        return;
      }
  });
  blocked.check(
    "Stage the deletion of the related old item or unstage the related new item before operating on this file",
  );
}
async function diskTarget(repo: Repo, path: string, blocked?: Blockers) {
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const current = parts.slice(0, i + 1).join("/");
    let info;
    try {
      info = await lstat(join(repo.rootPath, current), { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (i < parts.length - 1) {
      if (info.isDirectory()) continue;
      blocked?.add(current);
      return;
    }
    if (blocked && info.isDirectory()) {
      blocked.add(path);
      const directory = await opendir(join(repo.rootPath, path), {
        encoding: "buffer" as BufferEncoding,
      });
      try {
        for await (const entry of directory) {
          blocked.add(
            path + "/" + utf8(Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name)),
          );
          if (blocked.truncated) break;
        }
      } finally {
        await directory.close().catch(() => {});
      }
    } else if (blocked && !info.isFile() && !info.isSymbolicLink()) blocked.add(path);
    return info;
  }
}
async function forceRemove(repo: Repo, paths: string[], signal: AbortSignal) {
  if (paths.length)
    await git(repo.rootPath, ["update-index", "--force-remove", "-z", "--stdin"], signal, {
      input: nul(paths),
      write: true,
    });
}
async function steps(run: (done: (paths: string[]) => void) => Promise<void>) {
  const changed = new Set<string>();
  try {
    await run((paths) => paths.forEach((path) => changed.add(path)));
  } catch (error) {
    const reason = asError(error);
    throw new OperationError(
      reason.code,
      reason.message,
      changed.size ? "partial" : error instanceof OperationError ? error.outcome : "failed",
      {
        ...(error instanceof OperationError && typeof error.result === "object"
          ? error.result
          : {}),
        changedPaths: [...changed],
      },
      reason.details,
    );
  }
  return { changedPaths: [...changed] };
}
export async function changeIndex(
  repo: Repo,
  paths: string[],
  kind: "stage" | "unstage",
  signal: AbortSignal,
) {
  const entries = await selectedStatus(
    repo,
    paths,
    signal,
    kind === "unstage" ? "index" : undefined,
  );
  const remove: string[] = [],
    add: string[] = [];
  const head = kind === "unstage" ? await leaves(repo, paths, "HEAD", signal) : undefined;
  for (const path of paths) {
    const entry = entries.get(path);
    if (
      !entry ||
      (kind === "stage" ? entry.worktreeStatus === "." : [".", "?"].includes(entry.indexStatus))
    )
      throw new AppError("conflict", `${path} has changed state; refresh`);
    if (kind === "unstage") {
      (leaf(head!.get(path)) ? add : remove).push(path);
      continue;
    }
    if (entry.conflict && Object.values(entry.types).includes("gitlink"))
      throw new AppError(
        "unsupported",
        "Resolve submodule conflicts in the submodule repository or terminal",
      );
    const info = await diskTarget(repo, path);
    if (!info || (info.isDirectory() && entry.worktreeStatus === "D")) remove.push(path);
    else if (entry.submodule) {
      if (!entry.submodule.commitChanged || !info.isDirectory())
        throw new AppError(
          "unsupported",
          "Only submodule contents have changed; handle them in the submodule repository",
        );
      add.push(path);
    } else if (info.isFile() || info.isSymbolicLink()) add.push(path);
    else
      throw new AppError(
        "conflict",
        `${path} is a directory or special item and cannot be staged recursively`,
      );
  }
  await checkIndex(repo, add, remove, signal);
  return steps(async (done) => {
    await forceRemove(repo, remove, signal);
    done(remove);
    if (add.length) {
      const pathspecs = add.map((path) => `:(top,literal)${path}`);
      await git(
        repo.rootPath,
        kind === "stage"
          ? ["add", "-A", "--", ...pathspecs]
          : ["restore", "--no-recurse-submodules", "--source=HEAD", "--staged", "--", ...pathspecs],
        signal,
        { write: true },
      );
      done(add);
    }
  });
}
interface DiscardPlan {
  review: GitReview;
  restore: string[];
  remove: string[];
  unlink: string[];
}
async function discardPlan(
  repo: Repo,
  requested: string[],
  scope: DiscardScope,
  signal: AbortSignal,
): Promise<DiscardPlan> {
  const observation = await observeIndex(repo, signal);
  const selected = await selectedStatus(
    repo,
    requested,
    signal,
    scope === "all" ? "all" : undefined,
  );
  const paths = new Set(requested);
  const renamedOrigins = new Set<string>();
  for (const path of requested) {
    const entry = selected.get(path);
    if (!entry || (scope === "worktree" && entry.worktreeStatus === "."))
      throw new AppError("conflict", `${path} has changed state; refresh`);
    if (
      scope === "all" &&
      entry.oldPath &&
      (entry.indexStatus === "R" || entry.worktreeStatus === "R")
    ) {
      paths.add(entry.oldPath);
      renamedOrigins.add(entry.oldPath);
    }
  }
  if (paths.size > limits.listPageEntries * 2)
    throw new AppError("limit_exceeded", "Too many related paths; select fewer items");
  const ordered = [...paths].sort();
  const index = await leaves(repo, ordered, "index", signal);
  const source = scope === "all" ? await leaves(repo, ordered, "HEAD", signal) : index;
  const blocked = new Blockers();
  const restore: string[] = [],
    remove: string[] = [],
    deleted: string[] = [];
  const hash = createHash("sha256").update(
    JSON.stringify([repo.id, scope, ordered, observation.token]),
  );
  const summary: GitReview["summary"] = [];
  for (const path of ordered) {
    signal.throwIfAborted();
    const entry = selected.get(path);
    const untracked = entry?.indexStatus === "?" && !renamedOrigins.has(path);
    const from = untracked ? undefined : source.get(path);
    if (
      from?.mode === "160000" ||
      index.get(path)?.mode === "160000" ||
      Object.values(entry?.types ?? {}).includes("gitlink")
    )
      throw new AppError(
        "unsupported",
        "The parent repository cannot discard submodule contents; handle them in the submodule repository",
      );
    if (scope === "worktree" && entry?.conflict)
      throw new AppError(
        "unsupported",
        "Conflicting item has no single index content; edit the file or explicitly discard all changes",
      );
    const info = await diskTarget(repo, path, blocked);
    hash.update(JSON.stringify([path, from ?? null, info ? String(info.mode) : null]));
    if (info?.isFile()) {
      const handle = await open(
        join(repo.rootPath, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const content = createHash("sha256");
      try {
        for await (const data of handle.createReadStream()) {
          signal.throwIfAborted();
          content.update(data);
        }
      } finally {
        await handle.close();
      }
      hash.update(content.digest());
    } else if (info?.isSymbolicLink())
      hash.update(
        createHash("sha256")
          .update(await readlink(join(repo.rootPath, path), { encoding: "buffer" }))
          .digest(),
      );
    if (leaf(from)) restore.push(path);
    else {
      if (scope === "all" && !untracked) remove.push(path);
      if (info?.isFile() || info?.isSymbolicLink()) deleted.push(path);
    }
    summary.push({ path, action: leaf(from) ? "restore" : "delete" });
  }
  blocked.check("Move or delete blocking items in Files first, then review the discard again");
  if (scope === "all") await checkIndex(repo, restore, remove, signal);
  if ((await observeIndex(repo, signal)).token !== observation.token)
    throw new AppError("conflict", "HEAD/index changed during review; try again");
  const review = { paths: ordered, summary, reviewToken: hash.digest("hex") };
  if (Buffer.byteLength(JSON.stringify(review)) > limits.resultBytes)
    throw new AppError("limit_exceeded", "Too many paths to confirm; select fewer items");
  return { review, restore, remove, unlink: deleted };
}
export async function reviewDiscard(
  repo: Repo,
  paths: string[],
  scope: DiscardScope,
  signal: AbortSignal,
) {
  return (await discardPlan(repo, paths, scope, signal)).review;
}
export async function discard(
  repo: Repo,
  paths: string[],
  scope: DiscardScope,
  reviewToken: string,
  signal: AbortSignal,
) {
  const plan = await discardPlan(repo, paths, scope, signal);
  if (
    plan.review.reviewToken !== reviewToken ||
    JSON.stringify(plan.review.paths) !== JSON.stringify(paths)
  )
    throw new AppError("conflict", "Discard scope or content has changed; review again");
  return steps(async (done) => {
    await forceRemove(repo, plan.remove, signal);
    done(plan.remove);
    for (const path of plan.unlink) {
      signal.throwIfAborted();
      await unlink(join(repo.rootPath, path));
      done([path]);
    }
    if (plan.restore.length) {
      await git(
        repo.rootPath,
        [
          "restore",
          "--no-recurse-submodules",
          ...(scope === "all" ? ["--source=HEAD", "--staged"] : []),
          "--worktree",
          "--",
          ...plan.restore.map((path) => `:(top,literal)${path}`),
        ],
        signal,
        { write: true },
      );
      done(plan.restore);
    }
  });
}
