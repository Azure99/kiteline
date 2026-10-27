import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  OperationError,
  errorReply,
  type RepoDiscovery,
  type GitReview,
  type GitStatus,
} from "@kiteline/shared/protocol";
import { Agent } from "../src/agent.js";
import { gitProgressError } from "../src/git/process.js";
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

test.each([
  { method: "git.pull", remote: "missing" },
  { method: "git.pull", remote: 42 },
  { method: "git.push", remote: "missing" },
  { method: "git.push", remote: 42 },
] as const)(
  "$method dispatch ignores undeclared remote $remote and uses the configured upstream",
  async ({ method, remote }) => {
    const { data, root, cli, agent, signal, params } = await setup();
    const bare = join(data, "origin.git");
    await cli("clone", "--bare", root, bare);
    await cli("remote", "add", "origin", bare);
    await cli("push", "-u", "origin", "main");
    const source = method === "git.pull" ? join(data, "other") : root;
    if (method === "git.pull") {
      await cli("clone", bare, source);
      await cli("-C", source, "config", "user.name", "Other");
      await cli("-C", source, "config", "user.email", "other@example.test");
    }
    const contents = `${method} ${remote}\n`;
    await writeFile(join(source, "file.txt"), contents);
    await cli("-C", source, "commit", "-am", "synchronize change");
    const commitOid = await cli("-C", source, "rev-parse", "HEAD");
    if (method === "git.pull") await cli("-C", source, "push");
    const before = (await agent.dispatch("git.status", params, signal)) as GitStatus;
    await agent.dispatch(method, { ...params, remote, expectedHead: before.head }, signal);
    const destination = method === "git.pull" ? root : bare;
    expect(await cli("-C", destination, "rev-parse", "main")).toBe(commitOid);
    expect(await cli("-C", destination, "show", "main:file.txt")).toBe(contents);
    if (method === "git.pull")
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe(contents);
  },
);

test("fetch dispatch selects the requested remote and rejects stale names and wrong types", async () => {
  const { data, root, cli, agent, signal, params } = await setup();
  const origin = join(data, "origin.git");
  await cli("clone", "--bare", root, origin);
  await cli("remote", "add", "origin", origin);
  await cli("push", "-u", "origin", "main");
  const baseOid = (await cli("rev-parse", "HEAD")).trim();
  await cli("commit", "--allow-empty", "-m", "selected remote only");
  const selectedOid = (await cli("rev-parse", "HEAD")).trim();
  const selected = join(data, "selected.git");
  await cli("clone", "--bare", root, selected);
  await cli("reset", "--hard", baseOid);
  await cli("remote", "add", "selected", selected);
  await agent.dispatch("git.fetch", { ...params, remote: "selected" }, signal);
  expect((await cli("rev-parse", "selected/main")).trim()).toBe(selectedOid);
  expect((await cli("rev-parse", "origin/main")).trim()).toBe(baseOid);
  await cli("remote", "remove", "selected");
  await expect(
    agent.dispatch("git.fetch", { ...params, remote: "selected" }, signal),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    agent.dispatch("git.fetch", { ...params, remote: 42 }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("Git path RPCs reject unpaired surrogates without changing a legal replacement-character entry", async () => {
  const { root, cli, agent, signal, params } = await setup();
  await writeFile(join(root, "\uFFFD"), "legal Unicode contents\n");
  const index = await cli("ls-files", "--stage", "-z");
  for (const path of ["\uD800", "\uDC00"])
    await expect(
      agent.dispatch("git.stage", { ...params, paths: [path] }, signal),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    });
  expect(await cli("ls-files", "--stage", "-z")).toBe(index);
  expect(await readFile(join(root, "\uFFFD"), "utf8")).toBe("legal Unicode contents\n");
});

test("operation replies preserve diagnostics, uncertainty and observed Git progress", () => {
  const reason = {
    code: "permission_denied",
    message: "Cannot save run",
    details: { path: "state" },
  };
  const error = OperationError.from(reason, "unknown", { stdout: "done", changedPaths: ["old"] });
  expect(errorReply("request", error)).toEqual({
    id: "request",
    outcome: "unknown",
    error: reason,
    result: { stdout: "done", changedPaths: ["old"] },
  });
  for (const progressed of [false, true]) {
    expect(
      errorReply("request", gitProgressError(error, progressed, { changedPaths: ["new"] })),
    ).toEqual({
      id: "request",
      outcome: progressed ? "partial" : "unknown",
      error: reason,
      result: { stdout: "done", changedPaths: ["new"] },
    });
  }
});

test("Git dispatch preserves index, discard review, error invalidation and device directories", async () => {
  const { data, root, cli, agent, signal, params } = await setup();
  const changed = vi.spyOn(agent.watches, "notifyWritten");
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
  expect(changed).toHaveBeenCalledWith(params.workspaceId);
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

test("commit message dispatch reads the selected OID within its registered workspace", async () => {
  const { agent, cli, params, signal } = await setup();
  const commitOid = (await cli("rev-parse", "HEAD")).trim();
  await cli("commit", "--allow-empty", "-m", "new HEAD");
  expect(await agent.dispatch("git.commitMessage", { ...params, commitOid }, signal)).toEqual({
    message: "base\n",
  });
  await expect(
    agent.dispatch("git.commitMessage", { ...params, commitOid: "HEAD" }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(
    agent.dispatch("git.commitMessage", { ...params, repoId: "unknown", commitOid }, signal),
  ).rejects.toMatchObject({ code: "not_found" });
  const outside = await agent.metadata.add(await mkdtemp("/var/tmp/kiteline-git-outside-"));
  cleanups.push(() => rm(outside.path, { recursive: true, force: true }));
  await expect(
    agent.dispatch("git.commitMessage", { ...params, workspaceId: outside.id, commitOid }, signal),
  ).rejects.toMatchObject({ code: "not_found" });
});
