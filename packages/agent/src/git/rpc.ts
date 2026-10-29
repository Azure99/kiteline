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
import {
  branches,
  commitDiff,
  commitFiles,
  commitMessage,
  history,
  parseCommitOid,
} from "./history.js";
import {
  checkedGitPaths,
  discard,
  discardScope,
  gitPaths,
  reviewDiscard,
  stagePaths,
  unstagePaths,
} from "./changes.js";
import { commit, createBranch, deleteBranch, switchBranch } from "./refs.js";
import { expectedHead, remotes, syncRemote } from "./remotes.js";
import { finishOperation } from "./in-progress.js";
import { gitRead } from "./process.js";

type GitMethod = Extract<RpcMethod, `git.${string}` | "repos.discover">;
type RawGitWriteParams<M extends GitWriteMethod> = { [K in keyof RpcParams<M>]?: unknown };
type RunQueuedGitWrite = <T>(operation: (repo: Repo) => Promise<T>) => Promise<T>;
type GitWriteHandlers = {
  [M in GitWriteMethod]: (
    params: RawGitWriteParams<M>,
    runQueuedWrite: RunQueuedGitWrite,
    signal: AbortSignal,
    dataDir: string,
  ) => Promise<RpcResult<M>>;
};

async function checkBranchName(dataDir: string, name: string, signal: AbortSignal) {
  if (name.startsWith("-"))
    throw new AppError("invalid_argument", "Branch name cannot start with -");
  const result = await gitRead(dataDir, ["check-ref-format", `refs/heads/${name}`], signal, {
    allowedCodes: [0, 1],
  });
  if (result.code !== 0) throw new AppError("invalid_argument", "Invalid branch name");
}

const gitWriteHandlers = {
  "git.fetch": (params, runQueuedWrite, signal) => {
    const remote = optionalString(params.remote);
    return runQueuedWrite((repo) => syncRemote(repo, { kind: "fetch", remote }, signal));
  },
  "git.pull": (params, runQueuedWrite, signal) => {
    const head = expectedHead(params.expectedHead);
    return runQueuedWrite((repo) => syncRemote(repo, { kind: "pull", expectedHead: head }, signal));
  },
  "git.push": (params, runQueuedWrite, signal) => {
    const head = expectedHead(params.expectedHead);
    return runQueuedWrite((repo) => syncRemote(repo, { kind: "push", expectedHead: head }, signal));
  },
  "git.continue": (params, runQueuedWrite, signal) => {
    const expected = record(params.expectedOperation);
    const kind = string(expected.kind);
    const token = string(expected.token);
    return runQueuedWrite((repo) => finishOperation(repo, kind, token, "continue", signal));
  },
  "git.abort": (params, runQueuedWrite, signal) => {
    const expected = record(params.expectedOperation);
    const kind = string(expected.kind);
    const token = string(expected.token);
    return runQueuedWrite((repo) => finishOperation(repo, kind, token, "abort", signal));
  },
  "git.commit": (params, runQueuedWrite, signal) => {
    const message = string(params.message, "message", limits.controlMessageBytes);
    if (!message.trim()) throw new AppError("invalid_argument", "Enter a commit message");
    const indexToken = string(params.indexToken);
    return runQueuedWrite((repo) => commit(repo, message, indexToken, signal));
  },
  "git.branch.create": async (params, runQueuedWrite, signal, dataDir) => {
    const switchToBranch = params.switch;
    if (typeof switchToBranch !== "boolean")
      throw new AppError("invalid_argument", "Choose whether to switch branches");
    const name = string(params.name);
    const startOid = optionalString(params.startOid);
    if (startOid !== undefined) parseCommitOid(startOid);
    await checkBranchName(dataDir, name, signal);
    return runQueuedWrite((repo) => createBranch(repo, name, startOid, switchToBranch, signal));
  },
  "git.branch.switch": async (params, runQueuedWrite, signal, dataDir) => {
    const name = string(params.name);
    const refOid = string(params.refOid);
    await checkBranchName(dataDir, name, signal);
    return runQueuedWrite((repo) => switchBranch(repo, name, refOid, signal));
  },
  "git.branch.delete": async (params, runQueuedWrite, signal, dataDir) => {
    const name = string(params.name);
    const refOid = string(params.refOid);
    await checkBranchName(dataDir, name, signal);
    return runQueuedWrite((repo) => deleteBranch(repo, name, refOid, signal));
  },
  "git.stage": (params, runQueuedWrite, signal) => {
    const paths = gitPaths(params.paths);
    return runQueuedWrite(async (repo) =>
      stagePaths(repo, await checkedGitPaths(repo, paths, signal), signal),
    );
  },
  "git.unstage": (params, runQueuedWrite, signal) => {
    const paths = gitPaths(params.paths);
    return runQueuedWrite(async (repo) =>
      unstagePaths(repo, await checkedGitPaths(repo, paths, signal), signal),
    );
  },
  "git.discard": (params, runQueuedWrite, signal) => {
    const paths = gitPaths(params.paths);
    const scope = discardScope(params.scope);
    const reviewToken = string(params.reviewToken);
    return runQueuedWrite(async (repo) =>
      discard(repo, await checkedGitPaths(repo, paths, signal), scope, reviewToken, signal),
    );
  },
} satisfies GitWriteHandlers;

function isGitWriteMethod(method: string): method is GitWriteMethod {
  return Object.hasOwn(gitWriteHandlers, method);
}

export function isGitMethod(method: RpcMethod): method is GitMethod {
  return method === "repos.discover" || method.startsWith("git.");
}

export async function gitRpc(
  method: GitMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
  context: {
    repos: Repositories;
    writes: GitWriteQueue;
    dataDir: string;
    notifyWritten: (workspaceId: string) => void;
  },
  progress?: (value: FileProgress) => void,
): Promise<RpcResult<GitMethod>> {
  const resolveRepository = () =>
    context.repos.resolve(string(params.workspaceId), string(params.repoId), signal);
  if (isGitWriteMethod(method)) {
    const workspaceId = string(params.workspaceId);
    const repoId = string(params.repoId);
    const runQueuedWrite: RunQueuedGitWrite = (operation) =>
      context.writes
        .run(workspaceId, repoId, signal, operation, progress)
        .finally(() => context.notifyWritten(workspaceId));
    return await gitWriteHandlers[method](params, runQueuedWrite, signal, context.dataDir);
  }
  switch (method) {
    case "git.remotes":
      return (await remotes(await resolveRepository(), signal)) satisfies RpcResult<typeof method>;
    case "git.review": {
      const repo = await resolveRepository();
      return (await reviewDiscard(
        repo,
        await checkedGitPaths(repo, gitPaths(params.paths), signal),
        discardScope(params.scope),
        signal,
      )) satisfies RpcResult<typeof method>;
    }
    case "repos.discover":
      return (await context.repos.discover(
        string(params.workspaceId),
        optionalString(params.scanCursor),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "git.status":
      return (await status(
        await resolveRepository(),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        optionalString(params.expectedListToken),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "git.diff": {
      const repo = await resolveRepository();
      if (params.side === "commit")
        return (await commitDiff(
          repo,
          string(params.commitOid),
          optionalString(params.parentOid),
          string(params.path),
          signal,
        )) satisfies RpcResult<typeof method>;
      if (params.side !== "worktree" && params.side !== "staged")
        throw new AppError("invalid_argument", "Invalid diff side");
      return (await workingDiff(
        repo,
        string(params.path),
        params.side,
        signal,
      )) satisfies RpcResult<typeof method>;
    }
    case "git.history":
      return (await history(
        await resolveRepository(),
        optionalString(params.anchorOid),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "git.commitMessage":
      return (await commitMessage(
        await resolveRepository(),
        string(params.commitOid),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "git.commitFiles":
      return (await commitFiles(
        await resolveRepository(),
        string(params.commitOid),
        optionalString(params.parentOid),
        params.offset === undefined
          ? 0
          : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        signal,
      )) satisfies RpcResult<typeof method>;
    case "git.branches":
      return (await branches(await resolveRepository(), signal)) satisfies RpcResult<typeof method>;
    default: {
      const unhandled: never = method;
      throw new AppError("unsupported", `Unsupported operation: ${unhandled}`);
    }
  }
}
