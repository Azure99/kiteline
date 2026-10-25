import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { CursorBudget } from "../../src/cursor-budget.js";
import { Repositories } from "../../src/git/repos.js";
import type { MetadataStore } from "../../src/metadata.js";

const exec = promisify(execFile);

export async function isolateGitEnvironment() {
  const home = await mkdtemp("/var/tmp/kiteline-git-env-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", undefined);
  return home;
}

export async function gitRepoFixture(root: string) {
  const cli = (...args: string[]) => exec("git", args, { cwd: root });
  await cli("init");
  await cli("symbolic-ref", "HEAD", "refs/heads/main");
  await cli("config", "user.name", "Kiteline Test");
  await cli("config", "user.email", "kiteline@example.test");
  return cli;
}

export async function workspaceFixture(root: string, metadata: MetadataStore) {
  const workspace = await metadata.add(root);
  const repos = new Repositories(metadata, new CursorBudget());
  const found = await repos.discover(workspace.id, undefined, new AbortController().signal);
  return { workspace, repos, repo: found.repos[0]! };
}
