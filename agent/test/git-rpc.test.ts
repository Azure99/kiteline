import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type RepoDiscovery, type GitReview } from "@kiteline/shared/protocol";
import { Agent } from "../src/agent.js";
import { testConfig } from "./support/config.js";
import { gitRepoFixture, isolateGitEnvironment } from "./support/git.js";

const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  const home = await isolateGitEnvironment();
  cleanups.push(() => rm(home, { recursive: true, force: true }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup() {
  const data = await mkdtemp("/var/tmp/kiteline-git-rpc-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const run = await gitRepoFixture(root);
  const cli = async (...args: string[]) => (await run(...args)).stdout;
  await writeFile(join(root, "file.txt"), "original\n");
  await cli("add", "file.txt");
  await cli("commit", "-m", "base");
  const agent = new Agent(testConfig(data), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(root);
  const signal = new AbortController().signal;
  const found = (await agent.dispatch(
    "repos.discover",
    { workspaceId: workspace.id },
    signal,
  )) as RepoDiscovery;
  expect(found.complete).toBe(true);
  expect(found.repos).toHaveLength(1);
  const params = { workspaceId: workspace.id, repoId: found.repos[0]!.id };
  return { data, root, cli, agent, signal, params };
}

test("Git dispatch preserves index, discard review, error invalidation and device directories", async () => {
  const { data, root, cli, agent, signal, params } = await setup();
  const changed = vi.spyOn(agent.watches, "changed");
  await writeFile(join(root, "file.txt"), "edited\n");
  expect(await agent.dispatch("git.status", params, signal)).toMatchObject({
    stagedCount: 0,
    totalCount: 1,
  });
  await agent.dispatch("git.stage", { ...params, paths: ["file.txt"] }, signal);
  expect(await cli("diff", "--cached", "--name-only")).toBe("file.txt\n");
  await agent.dispatch("git.unstage", { ...params, paths: ["file.txt"] }, signal);
  expect(await cli("diff", "--cached", "--name-only")).toBe("");
  const review = (await agent.dispatch(
    "git.review",
    { ...params, paths: ["file.txt"], scope: "worktree" },
    signal,
  )) as GitReview;
  await agent.dispatch(
    "git.discard",
    { ...params, paths: review.paths, scope: "worktree", reviewToken: review.reviewToken },
    signal,
  );
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("original\n");
  changed.mockClear();
  await expect(
    agent.dispatch("git.branch.create", { ...params, name: "topic" }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(changed).toHaveBeenCalledWith(params.workspaceId, true);
  const absolutePath = join(data, "outside-workspace");
  expect(await agent.dispatch("directories.mkdir", { absolutePath }, signal)).toEqual({
    path: absolutePath,
  });
  expect(await agent.dispatch("directories.list", { absolutePath }, signal)).toMatchObject({
    path: absolutePath,
    entries: { items: [] },
  });
});

test("Git dispatch cancels a queued write and the shared queue accepts the next write", async () => {
  const { root, cli, agent, signal, params } = await setup();
  await writeFile(join(root, "file.txt"), "edited\n");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = agent.gitWrites.run(params.workspaceId, params.repoId, signal, async () => {
    entered();
    await held;
  });
  await started;
  const controller = new AbortController();
  const progress: string[] = [];
  try {
    const queued = agent.dispatch(
      "git.stage",
      { ...params, paths: ["file.txt"] },
      controller.signal,
      (value) => progress.push(value.phase),
    );
    const rejected = expect(queued).rejects.toMatchObject({ code: "cancelled" });
    controller.abort(new AppError("cancelled", "Cancelled by caller"));
    await rejected;
    expect(progress).toEqual(["queued"]);
    expect(await cli("diff", "--cached", "--name-only")).toBe("");
  } finally {
    release();
    await first;
  }
  await agent.dispatch("git.stage", { ...params, paths: ["file.txt"] }, signal);
  expect(await cli("diff", "--cached", "--name-only")).toBe("file.txt\n");
});
