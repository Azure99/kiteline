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
      `写入已完成，但无法读取结果：${reason.message}`,
      "unknown",
      known,
    );
  }
}
export async function commit(repo: Repo, message: string, indexToken: string, signal: AbortSignal) {
  if (!message.trim()) throw new AppError("invalid_argument", "请输入提交消息");
  if ((await observeIndex(repo, signal)).token !== indexToken)
    throw new AppError("conflict", "HEAD/index 已变化，请刷新后提交");
  let staged = false,
    conflicted = false;
  await readStatus(repo, signal, (entry) => {
    conflicted ||= entry.conflict;
    staged ||= ![".", "?"].includes(entry.indexStatus);
  });
  if (conflicted) throw new AppError("conflict", "仓库仍有未解决冲突");
  if (!staged) throw new AppError("conflict", "没有暂存的更改");
  await git(repo.rootPath, ["commit", "-F", "-"], signal, { input: message, write: true });
  const head = await headAfter(repo, signal, { committed: true });
  if (!head.oid)
    throw new OperationError("io_error", "提交已完成，HEAD 不可读，请刷新确认", "unknown", {
      committed: true,
    });
  return { commitOid: head.oid };
}
async function branchName(repo: Repo, name: string, signal: AbortSignal) {
  if (name.startsWith("-")) throw new AppError("invalid_argument", "分支名称不能以 - 开头");
  const result = await git(repo.rootPath, ["check-ref-format", `refs/heads/${name}`], signal, {
    allowedCodes: [0, 1],
  });
  if (result.code !== 0) throw new AppError("invalid_argument", "分支名称无效");
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
  if (!start) throw new AppError("conflict", "当前仓库尚无提交");
  await git(repo.rootPath, ["branch", "--no-recurse-submodules", "--", name, start], signal, {
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
        `分支已创建${switched ? "并已切换，但 Git 报错" : "；切换命令未正常完成"}：${reason.message}`,
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
    throw new AppError("conflict", "目标分支已变化，请刷新");
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
