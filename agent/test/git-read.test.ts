import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, rename, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { limits } from "@kiteline/shared/protocol";
import { MetadataStore } from "../src/metadata.js";
import { CursorBudget } from "../src/cursor-budget.js";
import { defaultAgentLimits } from "../src/config.js";
import { Repositories } from "../src/git/repos.js";
import { observeIndex, status } from "../src/git/status.js";
import { workingDiff } from "../src/git/diff.js";
import { branches, commitDiff, GitHistoryReads, history } from "../src/git/history.js";

const run = promisify(execFile);
const roots: string[] = [];
const signals = () => new AbortController().signal;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp("/var/tmp/kiteline-git-read-");
  roots.push(home);
  const root = join(home, "project");
  await mkdir(root);
  const cli = (...args: string[]) =>
    run("git", args, {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  await cli("init", "-b", "main");
  await cli("config", "user.name", "Kiteline Test");
  await cli("config", "user.email", "kiteline@example.test");
  const metadata = new MetadataStore({
    dataDir: home,
    runDir: join(home, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits },
  });
  const workspace = await metadata.add(root);
  const repos = new Repositories(metadata, new CursorBudget());
  const found = await repos.discover(workspace.id, undefined, signals());
  return { home, root, cli, metadata, workspace, repos, repo: found.repos[0]! };
}
test("leaving a workspace cancels its active discovery without returning a dead cursor", async () => {
  const { workspace, repos } = await setup();
  const pending = repos.discover(workspace.id, undefined, signals());
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await repos.retain(new Set());
  await cancelled;
  await repos.close();
});
test("discovery keeps nested and linked worktrees distinct and excludes external parents and directory links", async () => {
  const { root, home, cli, metadata, workspace, repos, repo } = await setup();
  await writeFile(join(root, "base"), "base");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  const nested = join(root, "ignored", "nested\n");
  await mkdir(nested, { recursive: true });
  await run("git", ["init", nested]);
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await cli("worktree", "add", "-b", "other", join(root, "linked"));
  await symlink(nested, join(root, "link"));
  await mkdir(join(root, "broken"));
  await writeFile(join(root, "broken", ".git"), "gitdir: missing\n");
  const found = await repos.discover(workspace.id, undefined, signals());
  expect(found.complete).toBe(true);
  expect(found.repos.map((item) => item.path).sort()).toEqual([".", "ignored/nested\n", "linked"]);
  const linked = found.repos.find((item) => item.linked)!;
  expect(linked.commonDir).toBe(repo.commonDir);
  expect(linked.id).not.toBe(repo.id);
  expect(found.issues.map((item) => item.path)).toEqual(["broken"]);
  const child = await metadata.add(join(root, "ignored"));
  expect(
    (await repos.discover(child.id, undefined, signals())).repos.map((item) => item.path),
  ).toEqual(["nested\n"]);
  await rename(root, join(home, "moved"));
  await expect(repos.resolve(workspace.id, repo.id, signals())).rejects.toMatchObject({
    code: "not_found",
  });
  await repos.close();
});
test("status pages count the whole repo, reject stale pages, and use semantic index observations", async () => {
  const { root, cli, repo, repos } = await setup();
  const unborn = await status(repo, 0, undefined, signals());
  expect(unborn.head).toEqual({ symbolicRef: "refs/heads/main", oid: null });
  await writeFile(join(root, "empty"), "");
  await cli("add", "-N", "empty");
  const intent = await observeIndex(repo, signals());
  await cli("add", "empty");
  expect((await observeIndex(repo, signals())).token).not.toBe(intent.token);
  await cli("commit", "-m", "base");
  await Promise.all(
    Array.from({ length: 503 }, (_, i) =>
      writeFile(join(root, `item-${String(i).padStart(4, "0")}`), "x"),
    ),
  );
  const first = await status(repo, 0, undefined, signals());
  expect(first.totalCount).toBe(503);
  expect(first.entries.length).toBe(limits.listPageEntries);
  expect((await status(repo, first.nextOffset!, first.listToken, signals())).entries.length).toBe(
    3,
  );
  const token = (await observeIndex(repo, signals())).token;
  await cli("status", "--porcelain");
  expect((await observeIndex(repo, signals())).token).toBe(token);
  await writeFile(join(root, "another"), "x");
  await expect(status(repo, 500, first.listToken, signals())).rejects.toMatchObject({
    code: "conflict",
  });
  expect((await status(repo, 999, undefined, signals())).totalCount).toBe(504);
  await cli("add", "item-0000");
  expect((await status(repo, 500, undefined, signals())).stagedCount).toBe(1);
  await repos.close();
}, 15_000);
test("diff preserves machine paths, rename, modes, binary and both sides without loading old untracked content", async () => {
  const { root, cli, repo, repos } = await setup();
  const old = "old\n[abc]",
    next = "-new *";
  await writeFile(join(root, old), "one\n\nthree\n");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await cli("config", "diff.suppressBlankEmpty", "true");
  await cli("config", "color.diff", "always");
  await cli("mv", "--", old, next);
  await writeFile(join(root, next), "one\n\nchanged");
  await writeFile(join(root, old), "unrelated untracked");
  const changes = await status(repo, 0, undefined, signals());
  expect(changes.entries.find((entry) => entry.path === next)).toMatchObject({
    oldPath: old,
    indexStatus: "R",
    worktreeStatus: "M",
  });
  const staged = await workingDiff(repo, next, "staged", signals());
  expect(staged.summary).toMatchObject({ path: next, oldPath: old, status: "R", binary: false });
  const working = await workingDiff(repo, next, "worktree", signals());
  expect(working.patch).not.toContain("\u001b");
  expect(working.patch).toContain("\n \n");
  expect(working.patch).toContain("No newline at end of file");
  expect(working.patch).not.toContain("unrelated untracked");
  await chmod(join(root, next), 0o755);
  expect((await workingDiff(repo, next, "worktree", signals())).summary.newMode).toBe("100755");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 3]));
  expect((await workingDiff(repo, "binary", "worktree", signals())).summary.binary).toBe(true);
  await writeFile(join(root, "untracked"), "a".repeat(limits.resultBytes + 100));
  const large = await workingDiff(repo, "untracked", "worktree", signals());
  expect(large.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(limits.resultBytes);
  await symlink("binary", join(root, "symlink"));
  const links = await status(repo, 0, undefined, signals());
  expect(links.entries.find((entry) => entry.path === "symlink")?.types.worktree).toBe("symlink");
  await repos.close();
}, 15_000);
test("history anchors pages and root commit files continue with exact paths and binary metadata", async () => {
  const { root, cli, repo, workspace, repos } = await setup();
  const reads = new GitHistoryReads(new CursorBudget());
  expect(await history(repo, undefined, 0, signals())).toEqual({ commits: [] });
  await Promise.all(
    Array.from({ length: 503 }, (_, i) => writeFile(join(root, `item-${i}`), "text\n")),
  );
  await writeFile(join(root, "special\n[]"), "root text\n");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await cli("add", ".");
  await cli("commit", "-m", "root subject");
  await cli("config", "log.showSignature", "true");
  await cli("config", "color.diff", "always");
  const original = await history(repo, undefined, 0, signals());
  expect(original.commits[0]).toMatchObject({
    parents: [],
    author: "Kiteline Test",
    subject: "root subject",
  });
  const oid = original.anchorOid!;
  const pending = reads.files(workspace.id, repo, oid, undefined, undefined, signals());
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  reads.retain(new Set());
  await cancelled;
  const first = await reads.files(workspace.id, repo, oid, undefined, undefined, signals());
  expect(first.files.items.length).toBe(500);
  expect(first.files.truncated).toBe(true);
  const second = await reads.files(
    workspace.id,
    repo,
    oid,
    undefined,
    first.files.nextCursor,
    signals(),
  );
  const all = [...first.files.items, ...second.files.items];
  expect(all.length).toBe(505);
  expect(new Set(all.map((item) => item.path)).size).toBe(505);
  expect(all.find((item) => item.path === "binary")?.binary).toBe(true);
  const patch = await commitDiff(repo, oid, undefined, "special\n[]", signals());
  expect(patch.summary).toMatchObject({ path: "special\n[]", status: "A", binary: false });
  expect(patch.patch).toContain("+root text");
  expect(patch.patch).not.toContain("\u001b");
  await cli("commit", "--allow-empty", "-m", "new head");
  expect((await history(repo, oid, 0, signals())).commits.map((item) => item.oid)).toEqual([oid]);
  expect((await history(repo, undefined, 0, signals())).commits.length).toBe(2);
  reads.close();
  await repos.close();
}, 15_000);
test("merge parents are explicit and branches expose linked worktree occupancy", async () => {
  const { root, home, cli, repo, workspace, repos } = await setup();
  const reads = new GitHistoryReads(new CursorBudget());
  await writeFile(join(root, "root"), "base");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await cli("switch", "-c", "feature");
  await writeFile(join(root, "feature"), "feature");
  await cli("add", ".");
  await cli("commit", "-m", "feature");
  await cli("switch", "main");
  await writeFile(join(root, "main"), "main");
  await cli("add", ".");
  await cli("commit", "-m", "main");
  await cli("merge", "--no-ff", "feature", "-m", "merge");
  const merge = (await history(repo, undefined, 0, signals())).commits[0]!;
  expect(merge.parents.length).toBe(2);
  await expect(
    reads.files(workspace.id, repo, merge.oid, undefined, undefined, signals()),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(
    (
      await reads.files(workspace.id, repo, merge.oid, merge.parents[0], undefined, signals())
    ).files.items.map((item) => item.path),
  ).toEqual(["feature"]);
  expect(
    (
      await reads.files(workspace.id, repo, merge.oid, merge.parents[1], undefined, signals())
    ).files.items.map((item) => item.path),
  ).toEqual(["main"]);
  const linked = join(home, "linked\t路径\n");
  await cli("worktree", "add", linked, "feature");
  const list = await branches(repo, signals());
  expect(list.branches.find((item) => item.name === "feature")).toMatchObject({
    current: false,
    worktreePath: linked,
  });
  expect(list.branches.find((item) => item.name === "main")?.current).toBe(true);
  reads.close();
  await repos.close();
}, 15_000);
test("single-file diffs exclude descendants when a file becomes a directory", async () => {
  const { root, cli, repo, repos } = await setup();
  const path = "item\n[]*";
  await writeFile(join(root, path), "old item\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await rm(join(root, path));
  await mkdir(join(root, path));
  await writeFile(join(root, path, "child"), "unselected child\n");
  await cli("add", "-A");
  const staged = await workingDiff(repo, path, "staged", signals());
  expect(staged.patch).toContain("-old item");
  expect(staged.patch).not.toContain("unselected child");
  await cli("commit", "-m", "file becomes directory");
  const oid = (await history(repo, undefined, 0, signals())).anchorOid!;
  const committed = await commitDiff(repo, oid, undefined, path, signals());
  expect(committed.patch).toContain("-old item");
  expect(committed.patch).not.toContain("unselected child");
  await cli("reset", "--hard", "HEAD~");
  await rename(join(root, path), join(root, "temporary"));
  await mkdir(join(root, path));
  await rename(join(root, "temporary"), join(root, path, "child"));
  await cli("add", "-A");
  const renamed = await workingDiff(repo, `${path}/child`, "staged", signals());
  expect(renamed.summary).toMatchObject({ status: "R", oldPath: path });
  expect(renamed.patch).toContain("-old item");
  expect(renamed.patch).toContain("+old item");
  await repos.close();
});
