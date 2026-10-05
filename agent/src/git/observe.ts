import { createHash } from "node:crypto";
import { AppError, type HeadIdentity, type Repo } from "@kiteline/shared/protocol";
import { commandLine, git, gitHash, NulRecords } from "./process.js";

export const diffOptions = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--relative=",
  "--ignore-submodules=none",
];
export async function headIdentity(root: string, signal: AbortSignal): Promise<HeadIdentity> {
  const ref = await git(root, ["symbolic-ref", "--quiet", "HEAD"], signal, {
    allowedCodes: [0, 1],
  });
  const commit = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal, {
    allowedCodes: [0, 1],
  });
  return {
    symbolicRef: ref.code === 0 ? commandLine(ref.bytes) : null,
    oid: commit.code === 0 ? commandLine(commit.bytes) : null,
  };
}
export async function emptyTree(root: string, signal: AbortSignal) {
  // Use this repository's object format without writing the tree.
  return commandLine(
    (await git(root, ["hash-object", "-t", "tree", "--stdin"], signal, { input: "" })).bytes,
  );
}
export async function observeIndex(repo: Repo, signal: AbortSignal) {
  const head = await headIdentity(repo.rootPath, signal);
  const base = head.oid ?? (await emptyTree(repo.rootPath, signal));
  const changed = createHash("sha256");
  let header = true,
    hasConflicts = false,
    hasStagedChanges = false;
  const reader = new NulRecords((record) => {
    // --no-renames yields one header and one raw pathname per change.
    if (header) {
      if (record.at(-1) === 85) hasConflicts = true;
      else hasStagedChanges = true;
    }
    header = !header;
  });
  await git(
    repo.rootPath,
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", ...diffOptions, base, "--"],
    signal,
    {
      onData: (chunk) => {
        changed.update(chunk);
        reader.data(chunk);
      },
    },
  );
  reader.end();
  if (!header) throw new AppError("io_error", "Git index diff is incomplete");
  const unmerged = hasConflicts
    ? await gitHash(repo.rootPath, ["ls-files", "--unmerged", "-z"], signal)
    : null;
  return {
    head,
    hasConflicts,
    hasStagedChanges,
    token: createHash("sha256")
      .update(JSON.stringify([repo.id, head, changed.digest("hex"), unmerged]))
      .digest("hex"),
  };
}
