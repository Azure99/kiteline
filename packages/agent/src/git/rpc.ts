import {
  AppError,
  integer,
  limits,
  optionalString,
  record,
  string,
  type FileProgress,
  type GitWriteMethod,
  type Repo,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
} from "@kiteline/shared/protocol";
import type { Repositories } from "./repos.js";
import type { GitWriteQueue } from "./queue.js";
import { status } from "./status.js";
import { workingDiff } from "./diff.js";
import { branches, commitDiff, commitFiles, commitMessage, history } from "./history.js";
import {
  stagePaths,
  unstagePaths,
  checkedGitPaths,
  discard,
  discardScope,
  reviewDiscard,
} from "./changes.js";
import { commit, createBranch, deleteBranch, switchBranch } from "./refs.js";
import { expectedHead, remotes, syncRemote } from "./remotes.js";
import { finishOperation } from "./in-progress.js";

type GitMethod = Extract<RpcMethod, `git.${string}` | "repos.discover">;

type RawGitWriteParams<M extends GitWriteMethod> = { [K in keyof RpcParams<M>]?: unknown };
type RunQueuedGitWrite = <T>(operation: (repo: Repo) => Promise<T>) => Promise<T>;
type GitWriteHandlers = {
  [M in GitWriteMethod]: (
    params: RawGitWriteParams<M>,
    runQueuedWrite: RunQueuedGitWrite,
    signal: AbortSignal,
  ) => Promise<RpcResult<M>>;
};

const gitWriteHandlers = {
  "git.fetch": (params, runQueuedWrite, signal) =>
    runQueuedWrite((repo) =>
      syncRemote(repo, "fetch", { remote: optionalString(params.remote) }, signal),
    ),
  "git.pull": (params, runQueuedWrite, signal) =>
    runQueuedWrite((repo) =>
      syncRemote(repo, "pull", { expectedHead: expectedHead(params.expectedHead) }, signal),
    ),
  "git.push": (params, runQueuedWrite, signal) =>
    runQueuedWrite((repo) =>
      syncRemote(repo, "push", { expectedHead: expectedHead(params.expectedHead) }, signal),
    ),
  "git.continue": (params, runQueuedWrite, signal) => {
    const expected = record(params.expectedOperation);
    return runQueuedWrite((repo) =>
      finishOperation(repo, string(expected.kind), string(expected.token), "continue", signal),
    );
  },
  "git.abort": (params, runQueuedWrite, signal) => {
    const expected = record(params.expectedOperation);
    return runQueuedWrite((repo) =>
      finishOperation(repo, string(expected.kind), string(expected.token), "abort", signal),
    );
  },
  "git.commit": (params, runQueuedWrite, signal) =>
    runQueuedWrite((repo) =>
      commit(
        repo,
        string(params.message, "message", limits.controlMessageBytes),
        string(params.indexToken),
        signal,
      ),
    ),
  "git.branch.create": (params, runQueuedWrite, signal) => {
    const switchToBranch = params.switch;
    if (typeof switchToBranch !== "boolean")
      throw new AppError("invalid_argument", "Choose whether to switch branches");
    return runQueuedWrite((repo) =>
      createBranch(
        repo,
        string(params.name),
        optionalString(params.startOid),
        switchToBranch,
        signal,
      ),
    );
  },
  "git.branch.switch": (params, runQueuedWrite, signal) =>
    runQueuedWrite((repo) =>
      switchBranch(repo, string(params.name), string(params.refOid), signal),
    ),
  "git.branch.delete": (params, runQueuedWrite, signal) =>
    runQueuedWrite((repo) =>
      deleteBranch(repo, string(params.name), string(params.refOid), signal),
    ),
  "git.stage": (params, runQueuedWrite, signal) =>
    runQueuedWrite(async (repo) =>
      stagePaths(repo, await checkedGitPaths(repo, params.paths, signal), signal),
    ),
  "git.unstage": (params, runQueuedWrite, signal) =>
    runQueuedWrite(async (repo) =>
      unstagePaths(repo, await checkedGitPaths(repo, params.paths, signal), signal),
    ),
  "git.discard": (params, runQueuedWrite, signal) =>
    runQueuedWrite(async (repo) =>
      discard(
        repo,
        await checkedGitPaths(repo, params.paths, signal),
        discardScope(params.scope),
        string(params.reviewToken),
        signal,
      ),
    ),
} satisfies GitWriteHandlers;

function isGitWriteMethod(method: string): method is GitWriteMethod {
  return Object.hasOwn(gitWriteHandlers, method);
}

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
  const runQueuedWrite: RunQueuedGitWrite = (operation) =>
    writes.run(string(params.workspaceId), string(params.repoId), signal, operation, progress);
  if (isGitWriteMethod(method)) return gitWriteHandlers[method](params, runQueuedWrite, signal);
  switch (method) {
    case "git.remotes":
      return remotes(await read(), signal) satisfies Promise<RpcResult<typeof method>>;
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
    case "git.commitMessage":
      return commitMessage(await read(), string(params.commitOid), signal) satisfies Promise<
        RpcResult<typeof method>
      >;
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
