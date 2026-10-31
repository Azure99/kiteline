import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  AppError,
  appVersion,
  OperationError,
  errorReply,
  type RepoDiscovery,
  type GitReview,
  type GitStatus,
  type Reply,
} from "@kiteline/shared/protocol";
import { Agent } from "../src/agent.js";
import { privateDirectory, type AgentConfig } from "../src/config.js";
import { Repositories } from "../src/git/repos.js";
import { gitProgressError } from "../src/git/process.js";
import { testConfig } from "./support/config.js";
import { gitRepoFixture, isolateGitEnvironment } from "./support/git.js";

const cleanups: (() => Promise<unknown>)[] = [];
const exec = promisify(execFile);
beforeEach(async () => {
  const home = await isolateGitEnvironment();
  cleanups.push(() => rm(home, { recursive: true, force: true }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(options: { server?: string; limits?: Partial<AgentConfig["limits"]> } = {}) {
  const data = await mkdtemp("/var/tmp/kiteline-git-rpc-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const run = await gitRepoFixture(root);
  const cli = async (...args: string[]) => (await run(...args)).stdout;
  await writeFile(join(root, "file.txt"), "original\n");
  await cli("add", "file.txt");
  await cli("commit", "-m", "base");
  const agent = new Agent(testConfig(data, { limits: options.limits }), {
    deviceId: "test",
    deviceToken: "test",
    server: options.server ?? "https://localhost",
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
  expect(changed).not.toHaveBeenCalled();
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
  const changed = vi.spyOn(agent.watches, "notifyWritten");
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
    await expect.poll(() => progress).toEqual(["queued"]);
    expect(changed).not.toHaveBeenCalled();
    controller.abort(new AppError("cancelled", "Cancelled by caller"));
    await rejected;
    expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
    expect(progress).toEqual(["queued"]);
    expect(await cli("diff", "--cached", "--name-only")).toBe("");
  } finally {
    release();
    await first;
  }
  await agent.dispatch("git.stage", { ...params, paths: ["file.txt"] }, signal);
  expect(await cli("diff", "--cached", "--name-only")).toBe("file.txt\n");
});

test.each([
  { method: "git.continue", input: { expectedOperation: null } },
  { method: "git.abort", input: { expectedOperation: [] } },
  { method: "git.branch.create", input: { switch: "yes", name: "topic" } },
  {
    method: "git.continue",
    input: { expectedOperation: { kind: 42, token: "token" } },
  },
  {
    method: "git.abort",
    input: { expectedOperation: { kind: "merge", token: 42 } },
  },
  { method: "git.branch.create", input: { switch: false, name: 42 } },
  { method: "git.commit", input: { message: " \n", indexToken: "token" } },
  { method: "git.stage", input: { paths: ["../outside"] } },
  { method: "git.discard", input: { paths: ["file.txt"], scope: "invalid", reviewToken: "token" } },
  { method: "git.pull", input: { expectedHead: { oid: null } } },
] as const)(
  "$method rejects invalid parameters before waiting for the write gate",
  async ({ method, input }) => {
    const { agent, params, signal, cli } = await setup();
    const changed = vi.spyOn(agent.watches, "notifyWritten");
    const before = await cli("ls-files", "--stage", "-z");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = agent.gitWrites.run(params.workspaceId, params.repoId, signal, async () => {
      entered();
      await gate;
    });
    await started;
    const progress: string[] = [];
    let settled = false;
    const pending = agent
      .dispatch(method, { ...params, ...input }, signal, (value) => progress.push(value.phase))
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await expect.poll(() => settled).toBe(true);
      expect(progress).toEqual([]);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      release();
      await held;
      await pending;
    }
    expect(await pending).toMatchObject({ error: { code: "invalid_argument" } });
    expect(progress).toEqual([]);
    expect(await cli("ls-files", "--stage", "-z")).toBe(before);
  },
);

test("branch JS parameters precede Git startup and startup failures stay outside the queue", async () => {
  const { data, agent, params, signal } = await setup();
  const changed = vi.spyOn(agent.watches, "notifyWritten");
  const progress: string[] = [];
  const branch = { ...params, name: "topic", switch: false };
  vi.stubEnv("PATH", join(data, "no-git"));
  for (const input of [{ workspaceId: 42 }, { repoId: 42 }, { startOid: "HEAD" }])
    await expect(
      agent.dispatch("git.branch.create", { ...branch, ...input }, signal, (value) =>
        progress.push(value.phase),
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(
    agent.dispatch("git.branch.switch", { ...branch, refOid: 42 }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  const failed = await agent
    .dispatch("git.branch.create", branch, signal, (value) => progress.push(value.phase))
    .catch((error: unknown) => errorReply("startup", error));
  expect(failed).toMatchObject({
    outcome: "failed",
    error: {
      code: "not_found",
    },
  });
  expect(progress).toEqual([]);
  expect(changed).not.toHaveBeenCalled();

  await expect(
    agent.dispatch("git.stage", { ...params, paths: ["file.txt"] }, signal, (value) =>
      progress.push(value.phase),
    ),
  ).rejects.toMatchObject({
    code: "not_found",
    message: expect.stringContaining("Repository is unavailable"),
  });
  expect(progress).toEqual(["queued"]);
  expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
});

test("branch grammar precedes repository lookup while valid names retain queue state checks", async () => {
  const { root, cli, agent, params, signal } = await setup();
  const changed = vi.spyOn(agent.watches, "notifyWritten");
  const oid = (await cli("rev-parse", "HEAD")).trim();
  const progress: string[] = [];
  const report = (value: { phase: string }) => progress.push(value.phase);
  for (const method of ["git.branch.create", "git.branch.switch", "git.branch.delete"])
    await expect(
      agent.dispatch(
        method,
        {
          workspaceId: "missing",
          repoId: "missing",
          name: "bad..name",
          switch: false,
          refOid: oid,
        },
        signal,
        report,
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(progress).toEqual([]);
  expect(changed).not.toHaveBeenCalled();

  const branch = { ...params, name: "topic", switch: false, startOid: oid };
  await expect(
    agent.dispatch("git.branch.create", { ...branch, repoId: "missing" }, signal, report),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(progress).toEqual([]);
  expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
  changed.mockClear();
  await expect(
    agent.dispatch("git.branch.create", { ...branch, workspaceId: "missing" }, signal, report),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(progress).toEqual(["queued"]);
  expect(changed).toHaveBeenCalledExactlyOnceWith("missing");
  changed.mockClear();
  progress.length = 0;

  await rename(root, root + ".moved");
  try {
    await expect(agent.dispatch("git.branch.create", branch, signal, report)).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );
    expect(progress).toEqual(["queued"]);
    expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
  } finally {
    await rename(root + ".moved", root);
  }
  changed.mockClear();
  progress.length = 0;

  await agent.dispatch("git.branch.create", branch, signal, report);
  expect(progress).toEqual(["queued", "running"]);
  await agent.dispatch("git.branch.switch", { ...params, name: "topic", refOid: oid }, signal);
  expect(await cli("branch", "--show-current")).toBe("topic\n");
  await agent.dispatch("git.branch.switch", { ...params, name: "main", refOid: oid }, signal);
  await agent.dispatch("git.branch.delete", { ...params, name: "topic", refOid: oid }, signal);
  expect(await cli("branch", "--list", "topic")).toBe("");
});

test("control Git deadlines cover queueing and branch validation", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { agent, params, signal, root, cli } = await setup({
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    limits: { rpcTimeout: 50, gitWriteTimeout: 1500 },
  });
  await writeFile(join(root, "completed.txt"), "within the Git deadline\n");
  await writeFile(join(root, "expired.txt"), "must not be staged\n");
  for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
  const connected = once(sockets, "connection");
  await agent.start();
  const [peer] = (await connected) as [WebSocket];
  const replies = new Map<string, Reply>();
  const progress = new Map<string, string[]>();
  peer.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "rpc.result") replies.set(message.reply.id, message.reply);
    if (message.type === "request.progress") {
      const phases = progress.get(message.id) ?? [];
      phases.push(message.phase);
      progress.set(message.id, phases);
    }
  });
  peer.send(JSON.stringify({ type: "welcome", connectionId: "test", serverVersion: appVersion }));
  for (const id of ["completed", "expired"]) {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = agent.gitWrites.run(params.workspaceId, params.repoId, signal, async () => {
      entered();
      await gate;
    });
    await started;
    try {
      peer.send(
        JSON.stringify({
          type: "rpc.request",
          id,
          method: "git.stage",
          params: { ...params, paths: [`${id}.txt`] },
        }),
      );
      await expect.poll(() => progress.get(id)).toEqual(["queued"]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(replies.has(id)).toBe(false);
      if (id === "completed") {
        release();
        await held;
        await expect
          .poll(() => replies.get(id))
          .toMatchObject({
            outcome: "succeeded",
            result: { changedPaths: ["completed.txt"] },
          });
        expect(progress.get(id)).toEqual(["queued", "running"]);
      } else {
        await expect
          .poll(() => replies.get(id), { timeout: 3000 })
          .toMatchObject({
            outcome: "failed",
            error: { code: "timeout" },
          });
        expect(progress.get(id)).toEqual(["queued"]);
      }
    } finally {
      release();
      await held;
    }
  }
  expect(await cli("diff", "--cached", "--name-only")).toBe("completed.txt\n");
  expect(await cli("show", ":completed.txt")).toBe("within the Git deadline\n");

  const actualGit = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const bin = join(agent.config.dataDir, "git-bin");
  const ready = join(bin, "grammar-ready");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
case " $* " in
  *" check-ref-format "*)
    echo ready > ${quote(ready)}
    exec sleep 30
    ;;
esac
exec ${quote(actualGit)} "$@"
`,
  );
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  const changed = vi.spyOn(agent.watches, "notifyWritten");
  const id = "grammar-timeout";
  peer.send(
    JSON.stringify({
      type: "rpc.request",
      id,
      method: "git.branch.create",
      params: { ...params, name: id, switch: false },
    }),
  );
  await expect.poll(() => readFile(ready, "utf8")).toBe("ready\n");
  expect(replies.has(id)).toBe(false);
  expect(progress.has(id)).toBe(false);
  await expect
    .poll(() => replies.get(id), { timeout: 4000 })
    .toMatchObject({ outcome: "failed", error: { code: "timeout" } });
  expect(progress.has(id)).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(await cli("branch", "--list", "grammar-*")).toBe("");
}, 15000);

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

test("a cancelled Git hook reports unknown through dispatch, notifies once, and releases the next write", async () => {
  const { agent, params, signal, root, cli } = await setup();
  await writeFile(join(root, "file.txt"), "ready to commit\n");
  await agent.dispatch("git.stage", { ...params, paths: ["file.txt"] }, signal);
  const before = (await agent.dispatch("git.status", params, signal)) as GitStatus;
  const hook = join(root, ".git/hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\necho ready > .git/hook-ready\nsleep 30\n");
  await chmod(hook, 0o755);
  const changed = vi.spyOn(agent.watches, "notifyWritten");
  const controller = new AbortController();
  const pending = agent.dispatch(
    "git.commit",
    { ...params, message: "cancelled commit", indexToken: before.indexToken },
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    code: "cancelled",
    outcome: "unknown",
  });
  try {
    await expect.poll(() => readFile(join(root, ".git/hook-ready"), "utf8")).toBe("ready\n");
    expect(changed).not.toHaveBeenCalled();
    controller.abort(new AppError("cancelled", "Cancel running Git"));
    await rejected;
    expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
    expect(await cli("log", "-1", "--format=%s")).toBe("base\n");

    await rm(hook);
    const current = (await agent.dispatch("git.status", params, signal)) as GitStatus;
    await agent.dispatch(
      "git.commit",
      { ...params, message: "after cancellation", indexToken: current.indexToken },
      signal,
    );
    expect(await cli("log", "-1", "--format=%s")).toBe("after cancellation\n");
    expect(await cli("show", "HEAD:file.txt")).toBe("ready to commit\n");
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    controller.abort(new AppError("cancelled", "Finish test Git operation"));
    await Promise.allSettled([pending, rejected]);
  }
}, 10000);

test("accepted Git dispatch awaits the queued write and notifies before close releases repositories and watches", async () => {
  const { root, cli, agent, signal, params } = await setup();
  await writeFile(join(root, "file.txt"), "edited\n");
  const order: string[] = [];
  const changed = vi.spyOn(agent.watches, "notifyWritten").mockImplementation(() => {
    order.push("changed");
  });
  const originalRepoClose = Repositories.prototype.close;
  const repoClose = vi.spyOn(Repositories.prototype, "close").mockImplementation(async function (
    this: Repositories,
  ) {
    order.push("repos.close");
    await originalRepoClose.call(this);
  });
  const originalWatchClose = agent.watches.close.bind(agent.watches);
  const watchClose = vi.spyOn(agent.watches, "close").mockImplementation(async () => {
    order.push("watches.close");
    await originalWatchClose();
  });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = agent.gitWrites.run(params.workspaceId, params.repoId, signal, async () => {
    entered();
    await gate;
  });
  await started;
  let queued!: () => void;
  const enqueued = new Promise<void>((resolve) => {
    queued = resolve;
  });
  let completed = false;
  const pending = agent
    .dispatch("git.stage", { ...params, paths: ["file.txt"] }, signal, (value) => {
      if (value.phase === "queued") queued();
    })
    .then((result) => {
      completed = true;
      return result;
    });
  let closing: Promise<void> | undefined;
  try {
    await enqueued;
    expect(completed).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(await cli("diff", "--cached", "--name-only")).toBe("");
    closing = agent.close();
    expect(repoClose).not.toHaveBeenCalled();
    expect(watchClose).not.toHaveBeenCalled();
    release();
    await held;
    expect(await pending).toEqual({ changedPaths: ["file.txt"] });
    await closing;
    expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
    expect(order[0]).toBe("changed");
    expect(order.slice(1).sort()).toEqual(["repos.close", "watches.close"]);
    expect(await cli("show", ":file.txt")).toBe("edited\n");
  } finally {
    release();
    await held;
    await pending;
    await closing;
  }
});

test("linked worktrees share the write gate and queued commits validate the current index token", async () => {
  const { root, cli, agent, signal, params } = await setup();
  const linked = join(root, "linked");
  await cli("worktree", "add", "-b", "linked", linked);
  const discovery = (await agent.dispatch(
    "repos.discover",
    { workspaceId: params.workspaceId },
    signal,
  )) as RepoDiscovery;
  const primary = discovery.repos.find((repo) => repo.id === params.repoId)!;
  const secondary = discovery.repos.find((repo) => repo.rootPath === linked)!;
  expect(secondary.id).not.toBe(primary.id);
  expect(secondary.commonDir).toBe(primary.commonDir);
  const linkedParams = { workspaceId: params.workspaceId, repoId: secondary.id };
  const changed = vi.spyOn(agent.watches, "notifyWritten");
  await writeFile(join(linked, "file.txt"), "linked edit\n");
  // Hold the primary worktree, then submit through the distinct linked repo ID.
  async function holdPrimary() {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = agent.gitWrites.run(params.workspaceId, params.repoId, signal, async () => {
      entered();
      await gate;
    });
    await started;
    return { release, held };
  }
  const first = await holdPrimary();
  const phases: string[] = [];
  const stage = agent.dispatch(
    "git.stage",
    { ...linkedParams, paths: ["file.txt"] },
    signal,
    (value) => phases.push(value.phase),
  );
  try {
    await expect.poll(() => phases).toEqual(["queued"]);
    expect(changed).not.toHaveBeenCalled();
    expect(await cli("-C", linked, "diff", "--cached", "--name-only")).toBe("");
  } finally {
    first.release();
    await first.held;
    await stage;
  }
  expect(phases).toEqual(["queued", "running"]);
  expect(changed).toHaveBeenCalledExactlyOnceWith(params.workspaceId);
  expect(await cli("-C", linked, "show", ":file.txt")).toBe("linked edit\n");
  expect(await cli("diff", "--cached", "--name-only")).toBe("");
  const before = (await agent.dispatch("git.status", linkedParams, signal)) as GitStatus;
  const head = await cli("-C", linked, "rev-parse", "HEAD");
  const second = await holdPrimary();
  const commitPhases: string[] = [];
  const pending = agent.dispatch(
    "git.commit",
    { ...linkedParams, message: "stale", indexToken: before.indexToken },
    signal,
    (value) => commitPhases.push(value.phase),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "conflict" });
  try {
    await expect.poll(() => commitPhases).toEqual(["queued"]);
    await writeFile(join(linked, "file.txt"), "external index change\n");
    await cli("-C", linked, "add", "file.txt");
  } finally {
    second.release();
    await second.held;
    await rejected;
  }
  expect(await cli("-C", linked, "rev-parse", "HEAD")).toBe(head);
  expect(await cli("-C", linked, "show", ":file.txt")).toBe("external index change\n");
});
