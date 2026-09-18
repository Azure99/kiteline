import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo, Workspace } from "@kiteline/shared/protocol";
import { WorkspaceWatches } from "../src/watches.js";

const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("watch event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
async function setup(capacity = 32) {
  const root = await mkdtemp("/var/tmp/kiteline-watch-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const events: { type: string; workspaceId: string; status?: string }[] = [];
  const watches = new WorkspaceWatches(capacity, (event) =>
    events.push(event as (typeof events)[number]),
  );
  cleanups.push(() => watches.close());
  const workspace = (id: string, path: string): Workspace => ({ id, path, name: id });
  return { root, watches, events, workspace };
}
test("directory replacement remains watched and deactivation stops events", async () => {
  const { root, watches, events, workspace } = await setup();
  await mkdir(join(root, "child"));
  watches.set([workspace("a", root)]);
  await until(() => events.some((event) => event.status === "normal"));
  events.length = 0;
  await rename(join(root, "child"), join(root, "old"));
  await mkdir(join(root, "child"));
  await until(() => events.some((event) => event.status === "normal"));
  events.length = 0;
  await writeFile(join(root, "child", "new"), "new content");
  await until(() => events.some((event) => event.type === "workspace.changed"));
  await watches.close();
  events.length = 0;
  await writeFile(join(root, "child", "new"), "after close");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(events).toEqual([]);
});
test("shared Git metadata invalidates both active worktrees", async () => {
  const { root, watches, events, workspace } = await setup();
  const a = join(root, "a"),
    b = join(root, "b");
  const git = (...args: string[]) => run("git", args, { cwd: a });
  await mkdir(a);
  await git("init", "-b", "main");
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
  await until(() => events.filter((event) => event.status === "normal").length >= 2);
  events.length = 0;
  await git("update-ref", "refs/heads/probe", "HEAD");
  await until(
    () =>
      new Set(
        events
          .filter((event) => event.type === "workspace.changed")
          .map((event) => event.workspaceId),
      ).size === 2,
  );
});
test("quota is reported and an explicitly listed ignored directory gets priority", async () => {
  const { root, watches, events, workspace } = await setup(1);
  const ignored = join(root, "node_modules");
  await mkdir(ignored);
  await mkdir(join(root, "normal"));
  watches.set([workspace("a", root)]);
  await until(() => events.some((event) => event.status === "degraded"));
  events.length = 0;
  watches.listed("a", ignored);
  await until(() => events.some((event) => event.status === "degraded"));
  events.length = 0;
  await writeFile(join(ignored, "visible"), "changed");
  await until(() => events.some((event) => event.type === "workspace.changed"));
});
