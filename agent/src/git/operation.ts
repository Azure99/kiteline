import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  asError,
  OperationError,
  type GitOperation,
  type HeadIdentity,
  type Repo,
} from "@kiteline/shared/protocol";
import { commandLine, git } from "./process.js";
import { observeIndex } from "./status.js";

export async function readOperation(
  repo: Repo,
  head: HeadIdentity,
  hasConflicts: boolean,
  signal: AbortSignal,
): Promise<GitOperation | undefined> {
  try {
    const hash = createHash("sha256").update(JSON.stringify([repo.id, head]));
    async function info(name: string) {
      signal.throwIfAborted();
      try {
        return await lstat(join(repo.gitDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    async function marker(name: string) {
      const metadata = await info(name);
      if (!metadata) return;
      if (!metadata.isFile()) throw new AppError("io_error", `${name} is not a regular state file`);
      const file = await open(join(repo.gitDir, name), "r");
      const stream = file.createReadStream({ signal });
      const digest = createHash("sha256");
      try {
        for await (const chunk of stream) digest.update(chunk as Buffer);
        hash.update(JSON.stringify([name, digest.digest("hex")]));
      } finally {
        stream.destroy();
        await file.close();
      }
    }
    async function steps(name: string, comment: string) {
      const metadata = await info(name);
      const commands = new Set<string>();
      if (!metadata) return commands;
      if (!metadata.isFile()) throw new AppError("io_error", `${name} is not a regular step file`);
      const file = await open(join(repo.gitDir, name), "r");
      const stream = file.createReadStream({ signal });
      let pending: Buffer = Buffer.alloc(0);
      function line(bytes: Buffer) {
        const value = bytes
          .toString()
          .replace(/^[ \t]+/, "")
          .replace(/\r$/, "");
        if (!value || (comment && value.startsWith(comment))) return;
        const word = value.split(/[ \t]/, 1)[0]!;
        commands.add(["pick", "p", "revert"].includes(word) ? word : "other");
      }
      try {
        for await (const chunk of stream) {
          signal.throwIfAborted();
          const bytes = chunk as Buffer;
          let start = 0;
          while (start < bytes.length) {
            const end = bytes.indexOf(10, start);
            const part = bytes.subarray(start, end < 0 ? bytes.length : end);
            if (pending.length + part.length > 64 * 1024)
              throw new AppError(
                "limit_exceeded",
                `${name} contains a line exceeding the state read size limit`,
              );
            pending = pending.length ? Buffer.concat([pending, part]) : part;
            if (end < 0) break;
            line(pending);
            pending = Buffer.alloc(0);
            start = end + 1;
          }
        }
        if (pending.length) line(pending);
      } finally {
        stream.destroy();
        await file.close();
      }
      return commands;
    }
    const mergeRebase = await info("rebase-merge");
    const applyRebase = await info("rebase-apply");
    const sequence = await info("sequencer");
    const merge = await info("MERGE_HEAD");
    const cherry = await info("CHERRY_PICK_HEAD");
    const revert = await info("REVERT_HEAD");
    if (
      !mergeRebase &&
      !applyRebase &&
      !sequence &&
      merge === undefined &&
      cherry === undefined &&
      revert === undefined
    )
      return;
    let kind: GitOperation["kind"], reason: string | undefined;
    let canContinue = !hasConflicts;
    if (hasConflicts) reason = "Resolve and stage conflicting files first";
    if (mergeRebase) {
      if (!mergeRebase.isDirectory())
        throw new AppError("io_error", "rebase-merge state is unreadable");
      kind = "rebase";
      await marker("rebase-merge/onto");
      await marker("REBASE_HEAD");
      let comment = "";
      try {
        comment = commandLine(
          (
            await git(repo.rootPath, ["stripspace", "--comment-lines"], signal, {
              input: "\n",
              maxBytes: 4096,
            })
          ).bytes,
        );
      } catch {
        signal.throwIfAborted();
      }
      const commands = new Set([
        ...(await steps("rebase-merge/git-rebase-todo", comment)),
        ...(await steps("rebase-merge/done", comment)),
      ]);
      if (!comment || [...commands].some((word) => word !== "pick" && word !== "p")) {
        canContinue = false;
        reason = comment
          ? "This rebase contains special steps; continue in the terminal"
          : "Cannot determine the Git comment prefix; continue in the terminal";
      }
    } else if (applyRebase) {
      if (!applyRebase.isDirectory())
        throw new AppError("io_error", "rebase-apply state is unreadable");
      const applying = await info("rebase-apply/applying"),
        rebasing = await info("rebase-apply/rebasing");
      if ((applying && !applying.isFile()) || (rebasing && !rebasing.isFile()))
        throw new AppError("io_error", "rebase-apply marker is not a regular state file");
      kind = applying !== undefined ? "am" : rebasing !== undefined ? "rebase" : "unknown";
      if (kind === "am") await marker("rebase-apply/patch");
      else if (kind === "rebase") {
        await marker("rebase-apply/onto");
        await marker("rebase-apply/original-commit");
      }
    } else if (cherry !== undefined || revert !== undefined || sequence) {
      if (sequence && !sequence.isDirectory())
        throw new AppError("io_error", "sequencer state is unreadable");
      const commands = await steps("sequencer/todo", "#");
      kind =
        cherry !== undefined
          ? "cherry-pick"
          : revert !== undefined
            ? "revert"
            : commands.size === 1 && commands.has("pick")
              ? "cherry-pick"
              : commands.size === 1 && commands.has("revert")
                ? "revert"
                : "unknown";
      await marker(
        cherry !== undefined
          ? "CHERRY_PICK_HEAD"
          : revert !== undefined
            ? "REVERT_HEAD"
            : "sequencer/todo",
      );
    } else if (merge !== undefined) {
      kind = "merge";
      await marker("MERGE_HEAD");
    } else kind = "unknown";
    if (kind === "unknown")
      return {
        kind,
        canContinue: false,
        canAbort: false,
        reason: "Cannot identify the current Git operation; handle it in the terminal",
      };
    hash.update(JSON.stringify(kind));
    return {
      kind,
      token: hash.digest("hex"),
      canContinue,
      canAbort: true,
      ...(reason ? { reason } : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      kind: "unknown",
      canContinue: false,
      canAbort: false,
      reason: `Cannot read the Git operation: ${asError(error).message}`,
    };
  }
}
async function currentOperation(repo: Repo, signal: AbortSignal) {
  const { head, hasConflicts } = await observeIndex(repo, signal);
  return { head, operation: await readOperation(repo, head, hasConflicts, signal) };
}
export async function finishOperation(
  repo: Repo,
  kind: string,
  token: string,
  action: "continue" | "abort",
  signal: AbortSignal,
) {
  const current = await currentOperation(repo, signal);
  const operation = current.operation;
  if (!operation?.token || operation.kind !== kind || operation.token !== token)
    throw new AppError("conflict", "Git operation has changed; refresh and confirm again");
  if (!(action === "continue" ? operation.canContinue : operation.canAbort))
    throw new AppError("conflict", operation.reason ?? "Current operation does not apply");
  let result;
  try {
    result = await git(repo.rootPath, [kind, `--${action}`], signal, {
      write: true,
      env: { GIT_EDITOR: "true" },
    });
  } catch (error) {
    const after = await currentOperation(repo, signal).catch(() => undefined);
    if (!after) throw error;
    const reason = asError(error);
    const moved =
      JSON.stringify(after.head) !== JSON.stringify(current.head) ||
      after.operation?.token !== operation.token;
    throw new OperationError(
      reason.code,
      reason.message,
      moved ? "partial" : error instanceof OperationError ? error.outcome : "failed",
      {
        ...(error instanceof OperationError && typeof error.result === "object"
          ? error.result
          : {}),
        headOid: after.head.oid,
        operationAfter: after.operation,
      },
      reason.details,
    );
  }
  try {
    const after = await currentOperation(repo, signal);
    return {
      headOid: after.head.oid,
      operationAfter: after.operation,
      stdout: result.text,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  } catch (error) {
    const reason = asError(error);
    throw new OperationError(reason.code, `Git command completed; ${reason.message}`, "unknown", {
      stdout: result.text,
      stderr: result.stderr,
      truncated: result.truncated,
    });
  }
}
