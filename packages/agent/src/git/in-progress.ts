import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  asError,
  type GitOperation,
  type HeadIdentity,
  type Repo,
} from "@kiteline/shared/protocol";
import { gitRead, gitProgressError, gitWrite, readAfterWrite } from "./process.js";
import { commandLine } from "./format.js";
import { observeIndex } from "./observe.js";

interface OperationState {
  kind: GitOperation["kind"];
  tokenFiles: string[];
  continueBlock?: string;
}

async function readStateInfo(gitDir: string, name: string, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    return await lstat(join(gitDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readMarkerDigest(gitDir: string, name: string, signal: AbortSignal) {
  const metadata = await readStateInfo(gitDir, name, signal);
  if (!metadata) return;
  if (!metadata.isFile()) throw new AppError("io_error", `${name} is not a regular state file`);
  const file = await open(join(gitDir, name), "r");
  const stream = file.createReadStream({ signal });
  const digest = createHash("sha256");
  try {
    for await (const chunk of stream) digest.update(chunk as Buffer);
    return digest.digest("hex");
  } finally {
    stream.destroy();
    await file.close();
  }
}

async function readSteps(gitDir: string, name: string, comment: string, signal: AbortSignal) {
  const metadata = await readStateInfo(gitDir, name, signal);
  const commands = new Set<string>();
  if (!metadata) return commands;
  if (!metadata.isFile()) throw new AppError("io_error", `${name} is not a regular step file`);
  const file = await open(join(gitDir, name), "r");
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

async function readOperationState(
  repo: Repo,
  signal: AbortSignal,
): Promise<OperationState | undefined> {
  const mergeRebase = await readStateInfo(repo.gitDir, "rebase-merge", signal);
  const applyRebase = await readStateInfo(repo.gitDir, "rebase-apply", signal);
  const sequence = await readStateInfo(repo.gitDir, "sequencer", signal);
  const merge = await readStateInfo(repo.gitDir, "MERGE_HEAD", signal);
  const cherry = await readStateInfo(repo.gitDir, "CHERRY_PICK_HEAD", signal);
  const revert = await readStateInfo(repo.gitDir, "REVERT_HEAD", signal);
  if (mergeRebase) {
    if (!mergeRebase.isDirectory())
      throw new AppError("io_error", "rebase-merge state is unreadable");
    let comment = "";
    try {
      comment = commandLine(
        (
          await gitRead(repo.rootPath, ["stripspace", "--comment-lines"], signal, {
            input: "\n",
            maxBytes: 4096,
          })
        ).bytes,
      );
    } catch {
      signal.throwIfAborted();
    }
    const commands = new Set([
      ...(await readSteps(repo.gitDir, "rebase-merge/git-rebase-todo", comment, signal)),
      ...(await readSteps(repo.gitDir, "rebase-merge/done", comment, signal)),
    ]);
    let continueBlock: string | undefined;
    if (!comment)
      continueBlock = "Cannot determine the Git comment prefix; continue in the terminal";
    else if ([...commands].some((word) => word !== "pick" && word !== "p"))
      continueBlock = "This rebase contains special steps; continue in the terminal";
    return { kind: "rebase", tokenFiles: ["rebase-merge/onto", "REBASE_HEAD"], continueBlock };
  }
  if (applyRebase) {
    if (!applyRebase.isDirectory())
      throw new AppError("io_error", "rebase-apply state is unreadable");
    const applying = await readStateInfo(repo.gitDir, "rebase-apply/applying", signal);
    const rebasing = await readStateInfo(repo.gitDir, "rebase-apply/rebasing", signal);
    if ((applying && !applying.isFile()) || (rebasing && !rebasing.isFile()))
      throw new AppError("io_error", "rebase-apply marker is not a regular state file");
    if (applying) return { kind: "am", tokenFiles: ["rebase-apply/patch"] };
    if (rebasing)
      return { kind: "rebase", tokenFiles: ["rebase-apply/onto", "rebase-apply/original-commit"] };
    return { kind: "unknown", tokenFiles: [] };
  }
  if (cherry !== undefined || revert !== undefined || sequence) {
    if (sequence && !sequence.isDirectory())
      throw new AppError("io_error", "sequencer state is unreadable");
    const commands = await readSteps(repo.gitDir, "sequencer/todo", "#", signal);
    if (cherry !== undefined) return { kind: "cherry-pick", tokenFiles: ["CHERRY_PICK_HEAD"] };
    if (revert !== undefined) return { kind: "revert", tokenFiles: ["REVERT_HEAD"] };
    let kind: GitOperation["kind"] = "unknown";
    if (commands.size === 1 && commands.has("pick")) kind = "cherry-pick";
    else if (commands.size === 1 && commands.has("revert")) kind = "revert";
    return { kind, tokenFiles: ["sequencer/todo"] };
  }
  if (merge !== undefined) return { kind: "merge", tokenFiles: ["MERGE_HEAD"] };
}

export async function readOperation(
  repo: Repo,
  head: HeadIdentity,
  hasConflicts: boolean,
  signal: AbortSignal,
): Promise<GitOperation | undefined> {
  try {
    const state = await readOperationState(repo, signal);
    if (!state) return;
    const hash = createHash("sha256").update(JSON.stringify([repo.id, head]));
    for (const name of state.tokenFiles) {
      const digest = await readMarkerDigest(repo.gitDir, name, signal);
      if (digest !== undefined) hash.update(JSON.stringify([name, digest]));
    }
    if (state.kind === "unknown")
      return {
        kind: "unknown",
        canContinue: false,
        canAbort: false,
        reason: "Cannot identify the current Git operation; handle it in the terminal",
      };
    hash.update(JSON.stringify(state.kind));
    const blockedByConflicts = !state.continueBlock && hasConflicts;
    const reason =
      state.continueBlock ??
      (blockedByConflicts ? "Resolve and stage conflicting files first" : undefined);
    return {
      kind: state.kind,
      token: hash.digest("hex"),
      canContinue: !reason,
      canAbort: true,
      ...(reason ? { reason } : {}),
      ...(blockedByConflicts ? ({ blocked: "conflicts" } as const) : {}),
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
    result = await gitWrite(repo.rootPath, [kind, `--${action}`], signal, {
      env: { GIT_EDITOR: "true" },
    });
  } catch (error) {
    const after = await currentOperation(repo, signal).catch(() => undefined);
    if (!after) throw error;
    const moved =
      JSON.stringify(after.head) !== JSON.stringify(current.head) ||
      after.operation?.token !== operation.token;
    throw gitProgressError(error, moved, {
      headOid: after.head.oid,
      operationAfter: after.operation,
    });
  }
  const after = await readAfterWrite(result, () => currentOperation(repo, signal));
  return { headOid: after.head.oid, operationAfter: after.operation, ...result };
}
