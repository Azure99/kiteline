import {
  AppError,
  asError,
  OperationError,
  type Repo,
  type RpcResult,
} from "@kiteline/shared/protocol";
import { commandLine, git } from "./process.js";
import { commitOid } from "./history.js";
import { headIdentity, observeIndex, readStatus } from "./status.js";

async function headAfter(repo: Repo, signal: AbortSignal, known: object) {
  try {
    return await headIdentity(repo.rootPath, signal);
  } catch (error) {
    const reason = asError(error);
    throw new OperationError(
      reason.code,
      `Write completed, but the result could not be read: ${reason.message}`,
      "unknown",
      known,
    );
  }
}
export async function commit(repo: Repo, message: string, indexToken: string, signal: AbortSignal) {
  if (!message.trim()) throw new AppError("invalid_argument", "Enter a commit message");
  if ((await observeIndex(repo, signal)).token !== indexToken)
    throw new AppError("conflict", "HEAD/index has changed; refresh before committing");
  let staged = false,
    conflicted = false;
  await readStatus(repo, signal, (entry) => {
    conflicted ||= entry.conflict;
    staged ||= ![".", "?"].includes(entry.indexStatus);
  });
  if (conflicted) throw new AppError("conflict", "Repository still has unresolved conflicts");
  if (!staged) throw new AppError("conflict", "No staged changes");
  await git(repo.rootPath, ["commit", "-F", "-"], signal, { input: message, write: true });
  const head = await headAfter(repo, signal, { committed: true });
  if (!head.oid)
    throw new OperationError(
      "io_error",
      "Commit completed, but HEAD is unreadable; refresh to verify",
      "unknown",
      {
        committed: true,
      },
    );
  return { commitOid: head.oid };
}
async function branchName(repo: Repo, name: string, signal: AbortSignal) {
  if (name.startsWith("-"))
    throw new AppError("invalid_argument", "Branch name cannot start with -");
  const result = await git(repo.rootPath, ["check-ref-format", `refs/heads/${name}`], signal, {
    allowedCodes: [0, 1],
  });
  if (result.code !== 0) throw new AppError("invalid_argument", "Invalid branch name");
}
export async function createBranch(
  repo: Repo,
  name: string,
  startOid: string | undefined,
  switchTo: boolean,
  signal: AbortSignal,
) {
  await branchName(repo, name, signal);
  const start = startOid
    ? await commitOid(repo, startOid, signal)
    : (await headIdentity(repo.rootPath, signal)).oid;
  if (!start) throw new AppError("conflict", "Current repository has no commits yet");
  await git(repo.rootPath, ["-c", "submodule.recurse=false", "branch", "--", name, start], signal, {
    write: true,
  });
  if (switchTo) {
    try {
      await git(repo.rootPath, ["switch", "--no-recurse-submodules", "--", name], signal, {
        write: true,
      });
    } catch (error) {
      const reason = asError(error);
      const head = await headIdentity(repo.rootPath, signal).catch(() => undefined);
      const switched = head?.symbolicRef === `refs/heads/${name}`;
      throw new OperationError(
        reason.code,
        `Branch created${switched ? " and switched to, but Git reported an error" : "; the switch command did not complete normally"}: ${reason.message}`,
        "partial",
        { created: true, ...(head ? { switched, head } : {}) },
        reason.details,
      );
    }
  }
  return {
    created: true,
    switched: switchTo,
    head: await headAfter(repo, signal, { created: true, switched: switchTo }),
  };
}
export function changeBranch(
  repo: Repo,
  name: string,
  refOid: string,
  kind: "switch",
  signal: AbortSignal,
): Promise<RpcResult<"git.branch.switch">>;
export function changeBranch(
  repo: Repo,
  name: string,
  refOid: string,
  kind: "delete",
  signal: AbortSignal,
): Promise<RpcResult<"git.branch.delete">>;
export async function changeBranch(
  repo: Repo,
  name: string,
  refOid: string,
  kind: "switch" | "delete",
  signal: AbortSignal,
): Promise<RpcResult<"git.branch.switch" | "git.branch.delete">> {
  await branchName(repo, name, signal);
  const actual = await git(
    repo.rootPath,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
    signal,
    { allowedCodes: [0, 1] },
  );
  if (actual.code !== 0 || commandLine(actual.bytes) !== refOid)
    throw new AppError("conflict", "Target branch has changed; refresh");
  await git(
    repo.rootPath,
    kind === "switch"
      ? ["switch", "--no-recurse-submodules", "--", name]
      : ["branch", "-d", "--", name],
    signal,
    { write: true },
  );
  return kind === "delete"
    ? ({ deleted: true } satisfies RpcResult<"git.branch.delete">)
    : ({
        head: await headAfter(repo, signal, { switched: true }),
      } satisfies RpcResult<"git.branch.switch">);
}
