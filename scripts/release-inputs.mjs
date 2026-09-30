import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function sourceDigest(root) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "agent",
      "server",
      "web",
      "shared",
      "terminal-recorder",
      "native",
      "scripts",
      "deploy",
      "package.json",
      "LICENSE",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig*.json",
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files exited with ${result.status}`);
  const files = result.stdout.split("\0").filter((file) => file && existsSync(join(root, file)));
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort())
    hash
      .update(file)
      .update("\0")
      .update(
        createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex"),
      )
      .update("\0");
  return hash.digest("hex");
}

export function releaseMatches(manifest, expected) {
  return ["kind", "platform", "version", "architecture", "node", "sourceDigest"].every(
    (key) => manifest[key] === expected[key],
  );
}
