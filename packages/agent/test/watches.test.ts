import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Repo, Workspace } from "@kiteline/shared/protocol";
import { WorkspaceWatches } from "../src/watches.js";
import { Repositories } from "../src/git/repos.js";
import { MetadataStore } from "../src/metadata.js";
import { CursorBudget } from "../src/cursor-budget.js";
import { testConfig } from "./support/config.js";

const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const pollOptions = { timeout: 5000, interval: 30 };
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kiteline-watch-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const events: { type: string; workspaceId: string; status?: string }[] = [];
  const watches = new WorkspaceWatches((event) => events.push(event));
  cleanups.push(() => watches.close());
  const workspace = (id: string, path: string): Workspace => ({ id, path, name: id });
  return { root, watches, events, workspace };
}
test.runIf(process.platform === "linux" || process.platform === "darwin")(
  "workspace watches follow moved subtrees and file changes without following symlinks",
  async () => {
    const { root, watches, events, workspace } = await setup();
    const project = join(root, "project"),
      incoming = join(root, "incoming"),
      outside = join(root, "outside");
    await mkdir(project);
    await mkdir(join(incoming, "nested"), { recursive: true });
    await writeFile(join(incoming, "nested", "file"), "original");
    await mkdir(outside);
    await writeFile(join(outside, "file"), "outside");
    await symlink(outside, join(project, "link"));
    watches.set([workspace("a", project)]);
    await expect
      .poll(() => events, pollOptions)
      .toContainEqual(expect.objectContaining({ status: "normal" }));
    events.length = 0;
    await appendFile(join(outside, "file"), "ignored");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(events).toEqual([]);
    await rename(incoming, join(project, "moved"));
    await expect
      .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
      .toBe(true);
    const file = join(project, "moved", "nested", "file"),
      renamed = join(project, "moved", "nested", "renamed");
    for (const change of [
      () => appendFile(file, "after move"),
      () => rename(file, renamed),
      () => rm(renamed),
    ]) {
      events.length = 0;
      await change();
      await expect
        .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
        .toBe(true);
    }
  },
);
test("directory replacement remains watched and deactivation stops events", async () => {
  const { root, watches, events, workspace } = await setup();
  await mkdir(join(root, "child"));
  watches.set([workspace("a", root)]);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await rename(join(root, "child"), join(root, "old"));
  await mkdir(join(root, "child"));
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await writeFile(join(root, "child", "new"), "new content");
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await writeFile(join(root, "replacement"), "atomic replacement");
  await rename(join(root, "replacement"), join(root, "child", "new"));
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await appendFile(join(root, "child", "new"), "after replacement");
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  await watches.close();
  events.length = 0;
  await writeFile(join(root, "child", "new"), "after close");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(events).toEqual([]);
});
test("an active discovered nested repository can move and keep file and Git notifications", async () => {
  const { root, watches, events, workspace } = await setup();
  const project = join(root, "project"),
    nested = join(project, "nested"),
    moved = join(project, "moved");
  await mkdir(join(nested, "deep", "child"), { recursive: true });
  await writeFile(join(nested, "deep", "child", "file"), "original\n");
  await run("git", ["init", nested]);
  const git = (path: string, ...args: string[]) => run("git", ["-C", path, ...args]);
  await git(nested, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(nested, "add", ".");
  await git(
    nested,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "base",
  );
  const metadata = new MetadataStore(testConfig(join(root, "data"), { runDir: join(root, "run") }));
  const repos = new Repositories(metadata, new CursorBudget());
  cleanups.push(() => repos.close());
  const signal = new AbortController().signal;
  watches.set([workspace("a", project)]);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  const repo = await repos.inspect(nested, project, signal);
  events.length = 0;
  watches.repo("a", repo);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  const expectExternalChange = async (change: () => Promise<unknown>) => {
    // Drain the previous phase's debounced events before observing a new external action.
    await new Promise((resolve) => setTimeout(resolve, 450));
    events.length = 0;
    await change();
    await expect
      .poll(
        () => [
          ...new Set(
            events
              .filter((event) => event.type === "workspace.changed")
              .map((event) => event.workspaceId),
          ),
        ],
        pollOptions,
      )
      .toEqual(["a"]);
  };
  await expectExternalChange(() => rename(nested, moved));
  const movedRepo = await repos.inspect(moved, project, signal);
  expect(movedRepo.id).not.toBe(repo.id);
  events.length = 0;
  watches.repo("a", movedRepo);
  watches.reposComplete("a", new Set([movedRepo.id]));
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  await expectExternalChange(() => appendFile(join(moved, "deep", "child", "file"), "edit\n"));
  await expectExternalChange(() => git(moved, "update-ref", "refs/heads/probe", "HEAD"));
  await expectExternalChange(() => git(moved, "symbolic-ref", "HEAD", "refs/heads/probe"));
  watches.set([]);
  await watches.close();
  events.length = 0;
  await appendFile(join(moved, "deep", "child", "file"), "after unsubscribe\n");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
}, 15_000);
test("shared Git metadata invalidates both active worktrees", async () => {
  const { root, watches, events, workspace } = await setup();
  const a = join(root, "a"),
    b = join(root, "b");
  const git = (...args: string[]) => run("git", args, { cwd: a });
  await mkdir(a);
  await git("init");
  await git("symbolic-ref", "HEAD", "refs/heads/main");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  );
  await git("worktree", "add", "-b", "other", b);
  watches.set([workspace("a", a), workspace("b", b)]);
  const repo = (id: string, path: string, gitDir: string): Repo => ({
    id,
    path: ".",
    rootPath: path,
    gitDir,
    commonDir: join(a, ".git"),
    available: true,
    linked: id === "b",
  });
  watches.repo("a", repo("a", a, join(a, ".git")));
  watches.repo("b", repo("b", b, join(a, ".git", "worktrees", "b")));
  await expect
    .poll(
      () =>
        new Set(
          events.filter((event) => event.status === "normal").map((event) => event.workspaceId),
        ).size === 2,
      pollOptions,
    )
    .toBe(true);
  events.length = 0;
  await git("update-ref", "refs/heads/probe", "HEAD");
  await expect
    .poll(
      () =>
        new Set(
          events
            .filter((event) => event.type === "workspace.changed")
            .map((event) => event.workspaceId),
        ).size === 2,
      pollOptions,
    )
    .toBe(true);
  watches.set([workspace("b", b)]);
  events.length = 0;
  await git("update-ref", "refs/heads/after-unsubscribe", "HEAD");
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  expect(events.filter((event) => event.type === "workspace.changed")).toEqual([
    { type: "workspace.changed", workspaceId: "b" },
  ]);
});
test("replacing registered shared Git metadata notifies its owners and honors repo removal", async () => {
  const { root, watches, events, workspace } = await setup();
  const a = join(root, "a"),
    b = join(root, "b"),
    metadata = join(root, "metadata"),
    replacement = join(root, "replacement");
  await mkdir(a);
  await mkdir(b);
  await mkdir(metadata);
  await writeFile(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  await cp(metadata, replacement, { recursive: true });
  watches.set([workspace("a", a), workspace("b", b)]);
  for (const [id, path] of [
    ["a", a],
    ["b", b],
  ] as const)
    watches.repo(id, {
      id,
      path: ".",
      rootPath: path,
      gitDir: metadata,
      commonDir: metadata,
      available: true,
      linked: id === "b",
    });
  await expect
    .poll(
      () =>
        new Set(
          events.filter((event) => event.status === "normal").map((event) => event.workspaceId),
        ).size,
      pollOptions,
    )
    .toBe(2);
  events.length = 0;
  await rename(metadata, join(root, "old-metadata"));
  await rename(replacement, metadata);
  await expect
    .poll(
      () =>
        [
          ...new Set(
            events
              .filter((event) => event.type === "workspace.changed")
              .map((event) => event.workspaceId),
          ),
        ].sort(),
      pollOptions,
    )
    .toEqual(["a", "b"]);
  events.length = 0;
  watches.reposComplete("a", new Set());
  await expect
    .poll(
      () => events.some((event) => event.workspaceId === "a" && event.status === "normal"),
      pollOptions,
    )
    .toBe(true);
  events.length = 0;
  await appendFile(join(metadata, "HEAD"), "updated\n");
  await expect
    .poll(
      () => events.some((event) => event.type === "workspace.changed" && event.workspaceId === "b"),
      pollOptions,
    )
    .toBe(true);
  expect(
    events.some((event) => event.type === "workspace.changed" && event.workspaceId === "a"),
  ).toBe(false);
});

test("dependencies stay ignored while repositories join metadata watching before scan completion", async () => {
  const { root, watches, events, workspace } = await setup();
  const ignored = join(root, "node_modules");
  const nested = join(ignored, "project");
  await mkdir(nested, { recursive: true });
  await run("git", ["init", nested]);
  watches.set([workspace("a", root)]);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await writeFile(join(nested, "ignored"), "no recursive subscription");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
  const gitDir = join(nested, ".git");
  watches.repo("a", {
    id: "nested",
    rootPath: nested,
    path: "node_modules/project",
    gitDir,
    commonDir: gitDir,
    available: true,
    linked: false,
  });
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await run("git", ["-C", nested, "symbolic-ref", "HEAD", "refs/heads/next"]);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await mkdir(join(gitDir, "objects", "aa"));
  await writeFile(join(gitDir, "objects", "aa", "object"), "not watched");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
  await mkdir(join(root, "new-project"));
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await run("git", ["init", join(root, "new-project")]);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  watches.reposComplete("a", new Set());
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await run("git", ["-C", nested, "symbolic-ref", "HEAD", "refs/heads/removed"]);
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
});

test("an external Git root resumes after replacement and excludes its object tree", async () => {
  const { root, watches, events, workspace } = await setup();
  const project = join(root, "project"),
    gitDir = join(root, "metadata");
  await run("git", ["init", "--separate-git-dir", gitDir, project]);
  const repo: Repo = {
    id: "original",
    rootPath: project,
    path: ".",
    gitDir,
    commonDir: gitDir,
    available: true,
    linked: false,
  };
  watches.set([workspace("a", project)]);
  watches.repo("a", repo);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  await cp(gitDir, join(root, "replacement"), { recursive: true });
  await rename(gitDir, join(root, "old"));
  await rename(join(root, "replacement"), gitDir);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await run("git", ["-C", project, "symbolic-ref", "HEAD", "refs/heads/replaced"]);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await mkdir(join(gitDir, "objects", "bb"));
  await writeFile(join(gitDir, "objects", "bb", "object"), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
});

test("a replaced non-Git workspace root resumes without subscribing to its siblings", async () => {
  const { root, watches, events, workspace } = await setup();
  const project = join(root, "project"),
    sibling = join(root, "sibling");
  await mkdir(project);
  await mkdir(sibling);
  watches.set([workspace("a", project)]);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await writeFile(join(sibling, "unrelated"), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
  await rename(project, join(root, "old"));
  await mkdir(project);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await writeFile(join(project, "new"), "reattached");
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
});

test("a bare workspace watches Git state without recursively watching objects", async () => {
  const { root, watches, events, workspace } = await setup();
  await run("git", ["init", "--bare", root]);
  watches.set([workspace("a", root)]);
  watches.repo("a", {
    id: "bare",
    path: ".",
    rootPath: root,
    gitDir: root,
    commonDir: root,
    available: false,
    linked: false,
  });
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await run("git", ["--git-dir", root, "symbolic-ref", "HEAD", "refs/heads/next"]);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
  events.length = 0;
  await mkdir(join(root, "objects", "cc"));
  await writeFile(join(root, "objects", "cc", "object"), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(events).toEqual([]);
});

test("discovery resolves a linked .git directory for external metadata watching", async () => {
  const { root, watches, events, workspace } = await setup();
  const project = join(root, "project");
  const metadataPath = join(root, "metadata");
  await run("git", ["init", project]);
  await run("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  ]);
  await rename(join(project, ".git"), metadataPath);
  await symlink("../metadata", join(project, ".git"));
  const metadata = new MetadataStore(testConfig(join(root, "data"), { runDir: join(root, "run") }));
  const repos = new Repositories(metadata, new CursorBudget());
  cleanups.push(() => repos.close());
  const repo = await repos.inspect(project, root, new AbortController().signal);
  expect(repo.commonDir).toBe(metadataPath);
  watches.set([workspace("a", project)]);
  watches.repo("a", repo);
  await expect
    .poll(() => events.some((event) => event.status === "normal"), pollOptions)
    .toBe(true);
  events.length = 0;
  await run("git", ["-C", project, "update-ref", "refs/heads/external", "HEAD"]);
  await expect
    .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
    .toBe(true);
});

test("closing during startup permits a new subscription and immediate write notifications", async () => {
  const { root, watches, events, workspace } = await setup();
  const a = join(root, "a"),
    b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  watches.set([workspace("a", a)]);
  const closing = watches.close();
  watches.set([workspace("b", b)]);
  await closing;
  await expect
    .poll(
      () => events.some((event) => event.workspaceId === "b" && event.status === "normal"),
      pollOptions,
    )
    .toBe(true);
  expect(events.some((event) => event.workspaceId === "a")).toBe(false);
  events.length = 0;
  watches.notifyWritten("a");
  expect(events).toEqual([]);
  watches.notifyWritten("b");
  expect(events).toMatchObject([{ type: "workspace.changed", workspaceId: "b" }]);
  events.length = 0;
  watches.set([workspace("a", a), workspace("b", b)]);
  await writeFile(join(b, "changed"), "still subscribed");
  await expect
    .poll(
      () => events.some((event) => event.type === "workspace.changed" && event.workspaceId === "b"),
      pollOptions,
    )
    .toBe(true);
  await watches.close();
  events.length = 0;
  watches.notifyWritten("b");
  expect(events).toEqual([]);
  watches.set([workspace("a", a)]);
  await expect
    .poll(
      () => events.some((event) => event.workspaceId === "a" && event.status === "normal"),
      pollOptions,
    )
    .toBe(true);
});

test.runIf(process.platform === "linux" || process.platform === "darwin")(
  "atomic directory replacement keeps overlapping workspaces watching",
  async () => {
    const { root, watches, events, workspace } = await setup();
    const project = join(root, "project"),
      child = join(project, "child"),
      replacement = join(root, "replacement");
    await mkdir(child, { recursive: true });
    await mkdir(replacement);
    watches.set([workspace("a", project), workspace("b", child)]);
    await expect
      .poll(
        () =>
          new Set(
            events.filter((event) => event.status === "normal").map((event) => event.workspaceId),
          ).size,
        pollOptions,
      )
      .toBe(2);
    events.length = 0;
    await rename(replacement, child);
    await expect
      .poll(
        () =>
          new Set(
            events
              .filter((event) => event.type === "workspace.changed")
              .map((event) => event.workspaceId),
          ).size,
        pollOptions,
      )
      .toBe(2);
    events.length = 0;
    await writeFile(join(child, "new"), "new directory");
    await expect
      .poll(
        () =>
          new Set(
            events
              .filter((event) => event.type === "workspace.changed")
              .map((event) => event.workspaceId),
          ).size,
        pollOptions,
      )
      .toBe(2);
    events.length = 0;
    await writeFile(join(root, "new-file"), "atomic file replacement");
    await rename(join(root, "new-file"), join(child, "new"));
    await expect
      .poll(
        () =>
          new Set(
            events
              .filter((event) => event.type === "workspace.changed")
              .map((event) => event.workspaceId),
          ).size,
        pollOptions,
      )
      .toBe(2);
    watches.set([workspace("b", child)]);
    events.length = 0;
    await appendFile(join(child, "new"), "one remaining owner");
    await expect
      .poll(
        () =>
          events.some((event) => event.type === "workspace.changed" && event.workspaceId === "b"),
        pollOptions,
      )
      .toBe(true);
    expect(events.some((event) => event.workspaceId === "a")).toBe(false);
  },
);

test.runIf(process.platform === "linux" || process.platform === "darwin")(
  "replacing an active parent notifies nested workspaces and Git metadata owners",
  async () => {
    const { root, watches, events, workspace } = await setup();
    const changedOwners = () =>
      [
        ...new Set(
          events
            .filter((event) => event.type === "workspace.changed")
            .map((event) => event.workspaceId),
        ),
      ].sort();
    const expectExternalChange = async (change: () => Promise<unknown>, owners: string[]) => {
      // Separate each action from the previous phase's pending debounced events.
      await new Promise((resolve) => setTimeout(resolve, 450));
      events.length = 0;
      await change();
      await expect.poll(changedOwners, pollOptions).toEqual(owners);
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(changedOwners()).toEqual(owners);
    };
    const project = join(root, "project"),
      child = join(project, "child"),
      metadata = join(project, "metadata"),
      a = join(root, "a"),
      b = join(root, "b"),
      replacement = join(root, "replacement");
    await mkdir(join(child, "deep"), { recursive: true });
    const file = join(child, "deep", "file");
    await writeFile(file, "original\n");
    await run("git", ["init", "--separate-git-dir", metadata, a]);
    const git = (path: string, ...args: string[]) => run("git", ["-C", path, ...args]);
    await git(
      a,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    );
    await git(a, "worktree", "add", "-b", "side", b);
    const commit = (await git(a, "rev-parse", "HEAD")).stdout.trim();
    const store = new MetadataStore(testConfig(join(root, "data"), { runDir: join(root, "run") }));
    const repos = new Repositories(store, new CursorBudget());
    cleanups.push(() => repos.close());
    const signal = new AbortController().signal;
    const repoA = await repos.inspect(a, a, signal);
    const repoB = await repos.inspect(b, b, signal);
    expect(repoA.gitDir).toBe(metadata);
    expect(repoA.commonDir).toBe(metadata);
    expect(repoB.commonDir).toBe(metadata);
    expect(repoB.gitDir).not.toBe(repoB.commonDir);
    await cp(project, replacement, { recursive: true });
    watches.set([
      workspace("parent", project),
      workspace("child", child),
      workspace("a", a),
      workspace("b", b),
    ]);
    watches.repo("a", repoA);
    watches.repo("b", repoB);
    await expect
      .poll(
        () =>
          new Set(
            events.filter((event) => event.status === "normal").map((event) => event.workspaceId),
          ).size,
        pollOptions,
      )
      .toBe(4);
    await expectExternalChange(
      () => rename(project, join(root, "old-project")),
      ["a", "b", "child", "parent"],
    );
    await expectExternalChange(() => rename(replacement, project), ["a", "b", "child", "parent"]);
    if (process.platform !== "linux") return;
    await expectExternalChange(
      () => appendFile(file, "after parent replacement\n"),
      ["child", "parent"],
    );
    await expectExternalChange(() => git(a, "update-ref", "refs/heads/probe", "HEAD"), ["a", "b"]);
    expect((await git(a, "rev-parse", "refs/heads/probe")).stdout.trim()).toBe(commit);
    await expectExternalChange(() => git(b, "symbolic-ref", "HEAD", "refs/heads/probe"), ["b"]);
    expect((await git(b, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/probe");
    watches.set([workspace("child", child), workspace("b", b)]);
    await expectExternalChange(() => appendFile(file, "remaining child owner\n"), ["child"]);
    await expectExternalChange(
      () => git(b, "update-ref", "refs/heads/after-release", "HEAD"),
      ["b"],
    );
    expect((await git(b, "rev-parse", "refs/heads/after-release")).stdout.trim()).toBe(commit);
    await expectExternalChange(
      () => git(b, "symbolic-ref", "HEAD", "refs/heads/after-release"),
      ["b"],
    );
    expect((await git(b, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/after-release");
  },
  20_000,
);

test.runIf(process.platform === "darwin")(
  "a missing workspace starts watching when its root is created",
  async () => {
    const { root, watches, events, workspace } = await setup();
    const project = join(root, "project");
    watches.set([workspace("a", project)]);
    await expect
      .poll(() => events.some((event) => event.status === "normal"), pollOptions)
      .toBe(true);
    events.length = 0;
    await mkdir(project);
    await expect
      .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
      .toBe(true);
    events.length = 0;
    await writeFile(join(project, "file"), "new root content");
    await expect
      .poll(() => events.some((event) => event.type === "workspace.changed"), pollOptions)
      .toBe(true);
  },
);
