import {
  AppError,
  integer,
  limits,
  optionalString,
  record,
  string,
  type FileProgress,
  type Repo,
  type RpcMethod,
  type RpcResult,
} from "@kiteline/shared/protocol";
import type { Repositories } from "./repos.js";
import type { GitWriteQueue } from "./queue.js";
import { status } from "./status.js";
import { workingDiff } from "./diff.js";
import { branches, commitDiff, commitFiles, history } from "./history.js";
import { changeIndex, checkedGitPaths, discard, discardScope, reviewDiscard } from "./changes.js";
import { changeBranch, commit, createBranch } from "./refs.js";
import { expectedHead, remotes, syncRemote } from "./remotes.js";
import { finishOperation } from "./in-progress.js";

type GitMethod = Extract<RpcMethod, `git.${string}` | "repos.discover">;

export function isGitMethod(method: RpcMethod): method is GitMethod {
  return method === "repos.discover" || method.startsWith("git.");
}

export async function gitRpc(
  repos: Repositories,
  writes: GitWriteQueue,
  method: GitMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
  progress?: (value: FileProgress) => void,
): Promise<RpcResult<GitMethod>> {
  const read = () => repos.resolve(string(params.workspaceId), string(params.repoId), signal);
  const write = <T>(operation: (repo: Repo) => Promise<T>) =>
    writes.run(string(params.workspaceId), string(params.repoId), signal, operation, progress);
  switch (method) {
    case "git.remotes":
      return remotes(await read(), signal) satisfies Promise<RpcResult<typeof method>>;
    case "git.fetch":
    case "git.pull":
    case "git.push":
      return write((repo) =>
        syncRemote(
          repo,
          method.slice(4) as "fetch" | "pull" | "push",
          {
            remote: optionalString(params.remote),
            expectedHead: method === "git.fetch" ? undefined : expectedHead(params.expectedHead),
          },
          signal,
        ),
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.continue":
    case "git.abort": {
      const expected = record(params.expectedOperation);
      return write((repo) =>
        finishOperation(
          repo,
          string(expected.kind),
          string(expected.token),
          method === "git.continue" ? "continue" : "abort",
          signal,
        ),
      ) satisfies Promise<RpcResult<typeof method>>;
    }
    case "git.commit":
      return write((repo) =>
        commit(
          repo,
          string(params.message, "message", limits.controlMessageBytes),
          string(params.indexToken),
          signal,
        ),
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branch.create":
      if (typeof params.switch !== "boolean")
        throw new AppError("invalid_argument", "Choose whether to switch branches");
      return write((repo) =>
        createBranch(
          repo,
          string(params.name),
          optionalString(params.startOid),
          params.switch === true,
          signal,
        ),
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branch.switch":
      return write((repo) =>
        changeBranch(repo, string(params.name), string(params.refOid), "switch", signal),
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branch.delete":
      return write((repo) =>
        changeBranch(repo, string(params.name), string(params.refOid), "delete", signal),
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.stage":
    case "git.unstage":
    case "git.discard":
      return write(async (repo) =>
        method === "git.discard"
          ? discard(
              repo,
              await checkedGitPaths(repo, params.paths, signal),
              discardScope(params.scope),
              string(params.reviewToken),
              signal,
            )
          : changeIndex(
              repo,
              await checkedGitPaths(repo, params.paths, signal),
              method === "git.stage" ? "stage" : "unstage",
              signal,
            ),
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.review": {
      const repo = await read();
      return reviewDiscard(
        repo,
        await checkedGitPaths(repo, params.paths, signal),
        discardScope(params.scope),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    }
    case "repos.discover":
      return repos.discover(
        string(params.workspaceId),
        optionalString(params.scanCursor),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.status":
      return status(
        await read(),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        optionalString(params.expectedListToken),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.diff": {
      const repo = await read();
      if (params.side === "commit")
        return commitDiff(
          repo,
          string(params.commitOid),
          optionalString(params.parentOid),
          string(params.path),
          signal,
        ) satisfies Promise<RpcResult<typeof method>>;
      if (params.side !== "worktree" && params.side !== "staged")
        throw new AppError("invalid_argument", "Invalid diff side");
      return workingDiff(repo, string(params.path), params.side, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    }
    case "git.history":
      return history(
        await read(),
        optionalString(params.anchorOid),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.commitFiles":
      return commitFiles(
        await read(),
        string(params.commitOid),
        optionalString(params.parentOid),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branches":
      return branches(await read(), signal) satisfies Promise<RpcResult<typeof method>>;
    default: {
      const unhandled: never = method;
      throw new AppError("unsupported", `Unsupported operation: ${unhandled}`);
    }
  }
}
