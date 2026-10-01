import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}

export const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function fetchPinned(input, target) {
  if (existsSync(target) && digest(target) === input.sha256) return;
  mkdirSync(dirname(target), { recursive: true });
  const pending = `${target}.${process.pid}.pending`;
  try {
    run("curl", ["--fail", "--location", "--output", pending, input.url]);
    if (digest(pending) !== input.sha256) throw new Error(`Checksum mismatch: ${input.url}`);
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}

export function sourceCommit(root) {
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  const commit = run("git", ["rev-parse", "HEAD"], options).trim();
  if (run("git", ["status", "--porcelain"], options).trim())
    throw new Error("Release builds require a clean Git worktree and index");
  return commit;
}

export function releaseMatches(manifest, expected) {
  return (
    manifest.sourceDirty === false &&
    ["kind", "platform", "version", "architecture", "node", "sourceCommit"].every(
      (key) => manifest[key] === expected[key],
    )
  );
}
