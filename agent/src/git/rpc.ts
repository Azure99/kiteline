import {
  AppError,
  integer,
  limits,
  record,
  string,
  type FileProgress,
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
import { finishOperation } from "./operation.js";

type GitMethod = Extract<RpcMethod, `git.${string}` | "repos.discover">;

export async function gitRpc(
  repos: Repositories,
  writes: GitWriteQueue,
  method: GitMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
  progress?: (value: FileProgress) => void,
): Promise<RpcResult<GitMethod>> {
  switch (method) {
    case "git.remotes":
      return remotes(
        await repos.resolve(string(params.workspaceId), string(params.repoId), signal),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.fetch":
    case "git.pull":
    case "git.push":
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        (repo) =>
          syncRemote(
            repo,
            method.slice(4) as "fetch" | "pull" | "push",
            {
              remote: params.remote === undefined ? undefined : string(params.remote),
              expectedHead: method === "git.fetch" ? undefined : expectedHead(params.expectedHead),
            },
            signal,
          ),
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.continue":
    case "git.abort": {
      const expected = record(params.expectedOperation);
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        (repo) =>
          finishOperation(
            repo,
            string(expected.kind),
            string(expected.token),
            method === "git.continue" ? "continue" : "abort",
            signal,
          ),
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    }
    case "git.commit":
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        (repo) =>
          commit(
            repo,
            string(params.message, "message", limits.controlMessageBytes),
            string(params.indexToken),
            signal,
          ),
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branch.create":
      if (typeof params.switch !== "boolean")
        throw new AppError("invalid_argument", "Choose whether to switch branches");
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        (repo) =>
          createBranch(
            repo,
            string(params.name),
            params.startOid === undefined ? undefined : string(params.startOid),
            params.switch === true,
            signal,
          ),
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branch.switch":
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        (repo) => changeBranch(repo, string(params.name), string(params.refOid), "switch", signal),
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branch.delete":
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        (repo) => changeBranch(repo, string(params.name), string(params.refOid), "delete", signal),
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.stage":
    case "git.unstage":
    case "git.discard":
      return writes.run(
        string(params.workspaceId),
        string(params.repoId),
        signal,
        async (repo) =>
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
        progress,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.review": {
      const repo = await repos.resolve(string(params.workspaceId), string(params.repoId), signal);
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
        params.scanCursor === undefined ? undefined : string(params.scanCursor),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.status":
      return status(
        await repos.resolve(string(params.workspaceId), string(params.repoId), signal),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        params.expectedListToken === undefined ? undefined : string(params.expectedListToken),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.diff": {
      const repo = await repos.resolve(string(params.workspaceId), string(params.repoId), signal);
      if (params.side === "commit")
        return commitDiff(
          repo,
          string(params.commitOid),
          params.parentOid === undefined ? undefined : string(params.parentOid),
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
        await repos.resolve(string(params.workspaceId), string(params.repoId), signal),
        params.anchorOid === undefined ? undefined : string(params.anchorOid),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.commitFiles":
      return commitFiles(
        await repos.resolve(string(params.workspaceId), string(params.repoId), signal),
        string(params.commitOid),
        params.parentOid === undefined ? undefined : string(params.parentOid),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "git.branches":
      return branches(
        await repos.resolve(string(params.workspaceId), string(params.repoId), signal),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    default: {
      const unhandled: never = method;
      throw new AppError("unsupported", `Unsupported operation: ${unhandled}`);
    }
  }
}
