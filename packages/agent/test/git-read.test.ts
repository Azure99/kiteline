import { agentLimits } from "../src/limits.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@kiteline/shared/protocol";
import { MetadataStore } from "../src/metadata.js";
import { testConfig } from "./support/config.js";
import { gitRepoFixture, isolateGitEnvironment, workspaceFixture } from "./support/git.js";
import { gitRead } from "../src/git/process.js";
import { observeIndex } from "../src/git/observe.js";
import { status } from "../src/git/status.js";
import { workingDiff } from "../src/git/diff.js";
import { changeIndex } from "../src/git/changes.js";
import { branches, commitDiff, commitFiles, commitMessage, history } from "../src/git/history.js";

const run = promisify(execFile);
const roots: string[] = [];
const signals = () => new AbortController().signal;
beforeEach(async () => {
  roots.push(await isolateGitEnvironment());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp("/var/tmp/kiteline-git-read-");
  roots.push(home);
  const root = join(home, "project");
  await mkdir(root);
  const cli = await gitRepoFixture(root);
  const metadata = new MetadataStore(testConfig(home), () => {});
  const { workspace, repos, repo } = await workspaceFixture(root, metadata);
  return { home, root, cli, metadata, workspace, repos, repo };
}
test.each([false, true])(
  "read stdout overflow stops the running Git alias with truncate=%s",
  async (truncate) => {
    const { root, cli, repos } = await setup();
    const script = join(root, ".git/output-loop");
    await writeFile(
      script,
      `#!/bin/sh
echo $$ > .git/output.pid
while :; do
  printf '0123456789abcdef\\n'
done
`,
    );
    await chmod(script, 0o755);
    await cli("config", "alias.output-loop", "!./.git/output-loop");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new AppError("timeout", "Read overflow did not stop Git")),
      2500,
    );
    const maxBytes = 64;
    const pending = gitRead(root, ["output-loop"], controller.signal, { maxBytes, truncate });
    try {
      if (truncate) {
        const result = await pending;
        expect(result.bytes.length).toBe(maxBytes);
        expect(result.text).toBe(result.bytes.toString());
        expect(result.truncated).toBe(true);
      } else await expect(pending).rejects.toMatchObject({ code: "limit_exceeded" });
      const pid = Number(await readFile(join(root, ".git/output.pid"), "utf8"));
      const state = await run("ps", ["-p", String(pid), "-o", "stat="]).catch((error) => {
        if (error.code !== 1) throw error;
        return { stdout: "" };
      });
      expect(state.stdout.trim()).toMatch(/^(Z.*)?$/);
    } finally {
      clearTimeout(timeout);
      controller.abort(new AppError("cancelled", "Clean up read overflow test"));
      await pending.catch(() => {});
      await repos.close();
    }
  },
);

test("leaving a workspace cancels its active discovery without returning a dead cursor", async () => {
  const { workspace, repos } = await setup();
  const pending = repos.discover(workspace.id, undefined, signals());
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await repos.retain(new Set());
  await cancelled;
  await repos.close();
});
test("discovery retains a distinct mixed-case metadata name on a case-sensitive volume", async () => {
  const { root, cli, workspace, repos } = await setup();
  const nested = join(root, ".GiT", "project");
  await mkdir(nested, { recursive: true });
  await cli("-C", nested, "init");
  try {
    const found = await repos.discover(workspace.id, undefined, signals());
    expect(found.complete).toBe(true);
    expect(found.repos.map((repo) => repo.path).sort()).toEqual([".", ".GiT/project"]);
  } finally {
    await repos.close();
  }
});
test("returning to a workspace keeps discovery started after leaving", async () => {
  const { workspace, repos } = await setup();
  const old = repos.discover(workspace.id, undefined, signals());
  const cancelled = expect(old).rejects.toMatchObject({ code: "cancelled" });
  const leaving = repos.retain(new Set());
  const returned = repos.discover(workspace.id, undefined, signals());
  const completed = expect(returned).resolves.toMatchObject({ complete: true });
  await Promise.all([leaving, cancelled, completed]);
  await repos.close();
});
test.each(["mod", "module[*]\n\\link", "[prefix]module", "-mod", "项目"])(
  "gitlink %s diffs include pointer changes without selecting a replacement directory",
  async (path) => {
    const { root, cli, repo, repos } = await setup();
    await cli("commit", "--allow-empty", "-m", "one");
    const one = (await cli("rev-parse", "HEAD")).stdout.trim();
    await cli("commit", "--allow-empty", "-m", "two");
    const two = (await cli("rev-parse", "HEAD")).stdout.trim();
    await cli("update-index", "--add", "--cacheinfo", `160000,${one},${path}`);
    await cli("commit", "-m", "module base");
    await cli("clone", "--no-checkout", "--", ".", path);
    await run("git", ["checkout", two], { cwd: join(root, path) });
    const worktree = await workingDiff(repo, path, "worktree", signals());
    await changeIndex(repo, [path], "stage", signals());
    const staged = await workingDiff(repo, path, "staged", signals());
    await cli("commit", "-m", "module pointer");
    const oid = (await cli("rev-parse", "HEAD")).stdout.trim();
    const historical = await commitDiff(repo, oid, undefined, path, signals());
    for (const result of [worktree, staged, historical]) {
      expect(result.patch).toContain(`-Subproject commit ${one}`);
      expect(result.patch).toContain(`+Subproject commit ${two}`);
    }
    await rm(join(root, path), { recursive: true });
    await mkdir(join(root, path, "deep"), { recursive: true });
    await writeFile(join(root, path, "child.txt"), "unselected child\n");
    await writeFile(join(root, path, "deep/child.txt"), "unselected deeper child\n");
    await cli("update-index", "--force-remove", "--", path);
    await cli("add", "-A");
    const removed = await workingDiff(repo, path, "staged", signals());
    expect(removed.patch).toContain(`-Subproject commit ${two}`);
    expect(removed.patch).not.toContain("unselected");
    await cli("commit", "-m", "replace module with directory");
    await cli(
      "update-index",
      "--force-remove",
      "--",
      `${path}/child.txt`,
      `${path}/deep/child.txt`,
    );
    await rm(join(root, path), { recursive: true });
    await cli("clone", "--no-checkout", "--", ".", path);
    await run("git", ["checkout", two], { cwd: join(root, path) });
    await cli("update-index", "--add", "--cacheinfo", `160000,${two},${path}`);
    const restored = await workingDiff(repo, path, "staged", signals());
    await cli("commit", "-m", "replace directory with module");
    const restoredOid = (await cli("rev-parse", "HEAD")).stdout.trim();
    const restoredHistory = await commitDiff(repo, restoredOid, undefined, path, signals());
    for (const result of [restored, restoredHistory]) {
      expect(result.patch).toContain(`+Subproject commit ${two}`);
      expect(result.patch).not.toContain("unselected");
    }
    await repos.close();
  },
);
test("untracked dash previews the file rather than standard input", async () => {
  const { root, repo, repos } = await setup();
  await writeFile(join(root, "-"), "actual file\n");
  const result = await workingDiff(repo, "-", "worktree", signals());
  expect(result.summary.path).toBe("-");
  expect(result.patch).toContain("+actual file");
  await repos.close();
});
test("non-UTF-8 paths stay local to their rows while valid names and history remain usable", async () => {
  const { root, cli, repo, repos, workspace } = await setup();
  const bad = (byte: number) => Buffer.concat([Buffer.from(root + "/"), Buffer.from([byte])]);
  for (const name of ["good", "\uFFFD", "\\xff"]) await writeFile(join(root, name), "valid\n");
  await writeFile(bad(0xe9), "invalid text\n");
  await writeFile(bad(0xff), Buffer.from([0, 1, 2]));
  expect((await repos.discover(workspace.id, undefined, signals())).issues).toEqual([]);
  await mkdir(bad(0xfe));
  expect((await repos.discover(workspace.id, undefined, signals())).issues).toMatchObject([
    { path: ".", error: { code: "unsupported" } },
  ]);
  await rm(bad(0xfe), { recursive: true });
  const untracked = await status(repo, 0, undefined, signals());
  expect(untracked.totalCount).toBe(5);
  expect(untracked.entries.filter((entry) => entry.path === undefined)).toHaveLength(2);
  await cli("add", ".");
  const staged = await status(repo, 0, undefined, signals());
  expect(staged.stagedCount).toBe(5);
  expect(
    staged.entries
      .filter((entry) => entry.path === undefined)
      .map((entry) => entry.pathError)
      .sort(),
  ).toEqual(["\\xe9", "\\xff"]);
  for (const path of ["good", "\uFFFD", "\\xff"])
    expect((await workingDiff(repo, path, "staged", signals())).patch).toContain("+valid");
  await cli("commit", "-m", "mixed names");
  const oid = (await cli("rev-parse", "HEAD")).stdout.trim();
  const files = await commitFiles(repo, oid, undefined, 0, signals());
  expect(files.files).toHaveLength(5);
  expect(files.files.find((item) => item.pathError === "\\xff")?.binary).toBe(true);
  expect(files.files.find((item) => item.path === "\\xff")?.binary).toBe(false);
  for (const path of ["good", "\uFFFD"])
    expect((await commitDiff(repo, oid, undefined, path, signals())).patch).toContain("+valid");
  const before = await observeIndex(repo, signals());
  await writeFile(bad(0xe9), "invalid changed\n");
  await writeFile(join(root, "good"), "valid changed\n");
  expect((await workingDiff(repo, "good", "worktree", signals())).patch).toContain(
    "+valid changed",
  );
  await cli("add", ".");
  expect((await observeIndex(repo, signals())).token).not.toBe(before.token);
  await repos.close();
});
test.each(["old", "new"])(
  "a non-UTF-8 rename %s end makes the whole row non-operable",
  async (end) => {
    const { root, cli, repo, repos } = await setup();
    const bad = Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff])]);
    const good = join(root, "good");
    const from = end === "old" ? bad : good;
    const to = end === "old" ? good : bad;
    await writeFile(from, end === "old" ? Buffer.from([0, 1, 2]) : "rename content\n");
    await cli("add", ".");
    await cli("commit", "-m", "base");
    await rename(from, to);
    await cli("add", "-A");
    const value = await status(repo, 0, undefined, signals());
    expect(value.entries).toHaveLength(1);
    expect(value.entries[0]).toMatchObject({
      indexStatus: "R",
      pathError: expect.stringContaining("\\xff"),
    });
    expect(value.entries[0]?.path).toBeUndefined();
    expect(value.entries[0]?.oldPath).toBeUndefined();
    await expect(workingDiff(repo, "good", "staged", signals())).rejects.toMatchObject({
      code: "conflict",
    });
    await cli("commit", "-m", "rename");
    const oid = (await cli("rev-parse", "HEAD")).stdout.trim();
    const files = await commitFiles(repo, oid, undefined, 0, signals());
    expect(files.files).toHaveLength(1);
    expect(files.files[0]?.path).toBeUndefined();
    expect(files.files[0]?.pathError).toBe(value.entries[0]?.pathError);
    expect(files.files[0]?.binary).toBe(end === "old");
    await expect(commitDiff(repo, oid, undefined, "good", signals())).rejects.toMatchObject({
      code: "not_found",
    });
    await repos.close();
  },
);
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
  await cli("read-tree", "--empty");
  expect((await observeIndex(repo, signals())).token).toBe(unborn.indexToken);
  await writeFile(join(root, "empty"), "");
  await cli("add", "-N", "empty");
  const intent = await observeIndex(repo, signals());
  expect(intent.hasStagedChanges).toBe(false);
  await cli("add", "empty");
  expect((await observeIndex(repo, signals())).token).not.toBe(intent.token);
  expect((await observeIndex(repo, signals())).hasStagedChanges).toBe(true);
  await cli("commit", "-m", "base");
  const remainingEntries = 3;
  const initialCount = agentLimits.listPageEntries + remainingEntries;
  await Promise.all(
    Array.from({ length: initialCount }, (_, i) =>
      writeFile(join(root, `item-${String(i).padStart(4, "0")}`), "x"),
    ),
  );
  const first = await status(repo, 0, undefined, signals());
  expect(first.totalCount).toBe(initialCount);
  expect(first.entries.length).toBe(agentLimits.listPageEntries);
  expect((await status(repo, first.nextOffset!, first.listToken, signals())).entries.length).toBe(
    remainingEntries,
  );
  const token = (await observeIndex(repo, signals())).token;
  await cli("status", "--porcelain");
  expect((await observeIndex(repo, signals())).token).toBe(token);
  await writeFile(join(root, "another"), "x");
  await expect(status(repo, first.nextOffset!, first.listToken, signals())).rejects.toMatchObject({
    code: "conflict",
  });
  const updatedCount = initialCount + 1;
  const beyondLastEntry = updatedCount + 1;
  expect((await status(repo, beyondLastEntry, undefined, signals())).totalCount).toBe(updatedCount);
  await cli("add", "item-0000");
  expect((await status(repo, first.nextOffset!, undefined, signals())).stagedCount).toBe(1);
  await repos.close();
}, 15_000);
test.each(["status", "commitFiles"] as const)(
  "%s checks oversized JSON entries after a full page and before the requested offset",
  async (reader) => {
    const { root, cli, repo, repos } = await setup();
    const originalLimits = { ...agentLimits };
    try {
      const resultBytes = 3 * 1024;
      const directory = ["z", ...Array.from({ length: 8 }, () => '"'.repeat(200))].join("/");
      const largePath = `${directory}/file`;
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, "a"), "small\n");
      await writeFile(join(root, largePath), "large path\n");
      await cli("add", ".");
      await cli("commit", "-m", "paths");
      const oid = (await cli("rev-parse", "HEAD")).stdout.trim();
      if (reader === "status") {
        await writeFile(join(root, "a"), "changed\n");
        await writeFile(join(root, largePath), "changed\n");
      }
      const read = (offset: number) =>
        reader === "status"
          ? status(repo, offset, undefined, signals())
          : commitFiles(repo, oid, undefined, offset, signals());
      const complete = await read(0);
      const items = "entries" in complete ? complete.entries : complete.files;
      expect(items.map((item) => item.path)).toEqual(["a", largePath]);
      expect(Buffer.byteLength(largePath)).toBeLessThan(resultBytes);
      expect(Buffer.byteLength(JSON.stringify(items[1]))).toBeGreaterThan(resultBytes);
      Object.assign(agentLimits, { resultBytes, listPageEntries: 1 });
      for (const offset of [0, items.length]) {
        await expect(read(offset)).rejects.toMatchObject({
          code: "limit_exceeded",
          message:
            reader === "status"
              ? "A Git change exceeds the size limit"
              : "A commit file entry exceeds the size limit",
        });
      }
    } finally {
      Object.assign(agentLimits, originalLimits);
      await repos.close();
    }
  },
);
test("status trims the complete envelope and derives continuation after every trim", async () => {
  const { root, cli, repo, repos } = await setup();
  const originalLimits = { ...agentLimits };
  try {
    await writeFile(join(root, "conflict"), "base\n");
    await cli("add", ".");
    await cli("commit", "-m", "base");
    await cli("switch", "-c", "other");
    await writeFile(join(root, "conflict"), "other\n");
    await cli("commit", "-am", "other");
    await cli("switch", "main");
    await writeFile(join(root, "conflict"), "main\n");
    await cli("commit", "-am", "main");
    const longBranch = Array.from({ length: 6 }, () => "b".repeat(200)).join("/");
    await cli("branch", "-m", longBranch);
    await expect(cli("merge", "other")).rejects.toMatchObject({ code: 1 });
    const untrackedPaths = Array.from({ length: 20 }, (_, i) => `untracked-${i}`);
    await Promise.all(untrackedPaths.map((path) => writeFile(join(root, path), "new\n")));
    const complete = await status(repo, 0, undefined, signals());
    expect(complete.entries).toHaveLength(untrackedPaths.length + 1);
    expect(complete.operation).toMatchObject({ kind: "merge", canContinue: false });
    expect(complete.truncated).toBe(false);
    const resultBytes = Buffer.byteLength(JSON.stringify(complete)) - 1;
    Object.assign(agentLimits, { resultBytes });
    const first = await status(repo, 0, undefined, signals());
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.entries.length).toBeLessThan(complete.entries.length);
    expect(first.nextOffset).toBe(first.offset + first.entries.length);
    expect(first.truncated).toBe(first.nextOffset !== undefined);
    expect(first.operation).toEqual(complete.operation);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(resultBytes);
    const last = await status(repo, first.nextOffset!, first.listToken, signals());
    expect([...first.entries, ...last.entries]).toEqual(complete.entries);
    expect(last.nextOffset).toBeUndefined();
    expect(last.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(resultBytes);
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...complete, entries: [] }));
    Object.assign(agentLimits, { resultBytes: envelopeBytes - 1 });
    await expect(status(repo, 0, undefined, signals())).rejects.toMatchObject({
      code: "limit_exceeded",
      message: "A Git change and repository information exceed the size limit",
    });
  } finally {
    Object.assign(agentLimits, originalLimits);
    await repos.close();
  }
});
test("diff preserves machine paths, rename, modes, binary and both sides without loading old untracked content", async () => {
  const { root, cli, repo, repos } = await setup();
  const old = "old\n[abc]",
    next = "-new *";
  await writeFile(join(root, old), "one\n\nthree\n");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await cli("config", "diff.suppressBlankEmpty", "true");
  await expect(workingDiff(repo, old, "worktree", signals())).rejects.toMatchObject({
    code: "conflict",
    details: { reason: "change_unavailable" },
  });
  await expect(workingDiff(repo, "../outside", "worktree", signals())).rejects.not.toMatchObject({
    details: { reason: "change_unavailable" },
  });
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
  await writeFile(join(root, "untracked"), "a".repeat(agentLimits.resultBytes + 100));
  const large = await workingDiff(repo, "untracked", "worktree", signals());
  expect(large.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(agentLimits.resultBytes);
  await symlink("binary", join(root, "symlink"));
  const links = await status(repo, 0, undefined, signals());
  expect(links.entries.find((entry) => entry.path === "symlink")?.types.worktree).toBe("symlink");
  await repos.close();
}, 15_000);
test("commit messages preserve the selected commit's full text independently of HEAD", async () => {
  const { home, cli, repo, repos } = await setup();
  try {
    const message =
      "完整主题\n\n中文正文第一段。\n保留换行。\n\nSecond paragraph.\n\nSigned-off-by: Test <test@example.test>\n\n";
    const path = join(home, "message");
    await writeFile(path, message);
    await cli("commit", "--allow-empty", "--cleanup=verbatim", "-F", path);
    const oid = (await cli("rev-parse", "HEAD")).stdout.trim();
    expect(oid).toHaveLength(40);
    await cli("commit", "--allow-empty", "-m", "new HEAD without body");
    const head = (await cli("rev-parse", "HEAD")).stdout.trim();
    const raw = (await cli("cat-file", "commit", oid)).stdout;
    expect(await commitMessage(repo, oid, signals())).toEqual({
      message: raw.slice(raw.indexOf("\n\n") + 2),
    });
    expect((await commitMessage(repo, oid, signals())).message).toBe(message);
    expect(await commitMessage(repo, head, signals())).toEqual({
      message: "new HEAD without body\n",
    });
    for (const invalid of ["HEAD", oid.slice(0, 8), "-" + oid])
      await expect(commitMessage(repo, invalid, signals())).rejects.toMatchObject({
        code: "invalid_argument",
      });
    const tree = (await cli("rev-parse", "HEAD^{tree}")).stdout.trim();
    await expect(commitMessage(repo, tree, signals())).rejects.toMatchObject({
      code: "io_error",
    });
    const controller = new AbortController();
    const pending = commitMessage(repo, oid, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    controller.abort(new AppError("cancelled", "Read cancelled"));
    await cancelled;
  } finally {
    await repos.close();
  }
});
test.each(["output", "JSON"])("commit messages enforce the %s byte limit", async (budget) => {
  const { home, cli, repo, repos } = await setup();
  try {
    const message =
      "subject\n\n" +
      (budget === "output"
        ? "x".repeat(agentLimits.resultBytes)
        : '"'.repeat(agentLimits.resultBytes / 2)) +
      "\n";
    if (budget === "JSON") expect(Buffer.byteLength(message)).toBeLessThan(agentLimits.resultBytes);
    const path = join(home, "message");
    await writeFile(path, message);
    await cli("commit", "--allow-empty", "--cleanup=verbatim", "-F", path);
    const oid = (await cli("rev-parse", "HEAD")).stdout.trim();
    await expect(commitMessage(repo, oid, signals())).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  } finally {
    await repos.close();
  }
});
test("history anchors pages and root commit files continue with exact paths and binary metadata", async () => {
  const { root, cli, repo, repos } = await setup();
  expect(await history(repo, undefined, 0, signals())).toEqual({ commits: [] });
  const extraTextFiles = 3;
  const textFileCount = agentLimits.listPageEntries + extraTextFiles;
  await Promise.all(
    Array.from({ length: textFileCount }, (_, i) => writeFile(join(root, `item-${i}`), "text\n")),
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
  const controller = new AbortController();
  const pending = commitFiles(repo, oid, undefined, 0, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  controller.abort(new AppError("cancelled", "Read cancelled"));
  await cancelled;
  const first = await commitFiles(repo, oid, undefined, 0, signals());
  expect(first.files.length).toBe(agentLimits.listPageEntries);
  expect(first.nextOffset).toBe(first.files.length);
  expect(await commitFiles(repo, oid, undefined, 0, signals())).toEqual(first);
  const second = await commitFiles(repo, oid, undefined, first.nextOffset!, signals());
  expect(second.nextOffset).toBeUndefined();
  const all = [...first.files, ...second.files];
  const totalFiles = textFileCount + 2; // The special pathname and binary file.
  expect(all.length).toBe(totalFiles);
  expect(new Set(all.map((item) => item.path)).size).toBe(totalFiles);
  expect(all.find((item) => item.path === "binary")).toEqual({
    path: "binary",
    status: "A",
    binary: true,
  });
  expect(
    all
      .filter((item) => !item.binary)
      .every((item) => item.additions === 1 && item.deletions === 0),
  ).toBe(true);
  const patch = await commitDiff(repo, oid, undefined, "special\n[]", signals());
  expect(patch.summary).toMatchObject({ path: "special\n[]", status: "A", binary: false });
  expect(patch.patch).toContain("+root text");
  expect(patch.patch).not.toContain("\u001b");
  await cli("commit", "--allow-empty", "-m", "new head");
  expect((await history(repo, oid, 0, signals())).commits.map((item) => item.oid)).toEqual([oid]);
  expect((await history(repo, undefined, 0, signals())).commits.length).toBe(2);
  await repos.close();
}, 15_000);
test("history skips within its anchor and checks oversized JSON only inside the Git window", async () => {
  const { cli, repo, repos } = await setup();
  const originalLimits = { ...agentLimits };
  try {
    const resultBytes = 3 * 1024;
    const listPageEntries = 2;
    const subject = '"'.repeat(1800);
    await cli("commit", "--allow-empty", "-m", subject);
    const large = (await history(repo, undefined, 0, signals())).commits[0]!;
    expect(Buffer.byteLength(subject)).toBeLessThan(resultBytes);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(resultBytes);
    const oids: string[] = [];
    const normalCommitCount = listPageEntries * 3;
    for (let i = 0; i < normalCommitCount; i++) {
      await cli("commit", "--allow-empty", "-m", `small commit ${i}`);
      oids.unshift((await cli("rev-parse", "HEAD")).stdout.trim());
    }
    Object.assign(agentLimits, { resultBytes, listPageEntries });
    const first = await history(repo, undefined, 0, signals());
    expect(first.commits.map((commit) => commit.oid)).toEqual(oids.slice(0, listPageEntries));
    expect(first.nextOffset).toBe(first.commits.length);
    await cli("commit", "--allow-empty", "-m", "new HEAD outside the anchor");
    const second = await history(repo, first.anchorOid, first.nextOffset!, signals());
    expect(second.anchorOid).toBe(first.anchorOid);
    expect(second.commits.map((commit) => commit.oid)).toEqual(
      oids.slice(first.nextOffset, first.nextOffset! + listPageEntries),
    );
    expect(second.nextOffset).toBe(first.nextOffset! + second.commits.length);
    // The next window has a full page of small commits, then the oversized commit.
    await expect(
      history(repo, first.anchorOid, second.nextOffset!, signals()),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      message: "A commit message exceeds the size limit",
    });
  } finally {
    Object.assign(agentLimits, originalLimits);
    await repos.close();
  }
});
test("commit file offsets continue at the actual byte-limited page length", async () => {
  const { root, cli, repo, repos } = await setup();
  const prefix = Array.from({ length: 8 }, () => "d".repeat(220)).join("/");
  await mkdir(join(root, prefix), { recursive: true });
  const paths = Array.from(
    { length: 300 },
    (_, i) => `${prefix}/item-${String(i).padStart(3, "0")}`,
  );
  await Promise.all(paths.map((path) => writeFile(join(root, path), "text\n")));
  await cli("add", ".");
  await cli("commit", "-m", "long paths");
  const oid = (await history(repo, undefined, 0, signals())).anchorOid!;
  const first = await commitFiles(repo, oid, undefined, 0, signals());
  expect(first.files.length).toBeGreaterThan(0);
  expect(first.files.length).toBeLessThan(paths.length);
  expect(first.nextOffset).toBe(first.files.length);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(agentLimits.resultBytes);
  const second = await commitFiles(repo, oid, undefined, first.nextOffset!, signals());
  expect([...first.files, ...second.files].map((file) => file.path)).toEqual(paths);
  expect(
    [...first.files, ...second.files].every((file) => file.additions === 1 && file.deletions === 0),
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(agentLimits.resultBytes);
  expect(second.nextOffset).toBeUndefined();
  await repos.close();
}, 15_000);
test("commit statistics preserve rename paths, zero counts, deletions and counts beyond patch truncation", async () => {
  const { root, cli, repo, repos } = await setup();
  const old = "old\tname.txt",
    next = "renamed\tline\nbreak.txt";
  await writeFile(join(root, old), "keep\n".repeat(10));
  await writeFile(join(root, "mode.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(root, "gone.txt"), "gone\nsecond\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await rename(join(root, old), join(root, next));
  await writeFile(join(root, next), "keep\n".repeat(10) + "added\n");
  await chmod(join(root, "mode.sh"), 0o755);
  await rm(join(root, "gone.txt"));
  await writeFile(join(root, "large.txt"), "a complete added line\n".repeat(70_000));
  await cli("add", ".");
  await cli("commit", "-m", "mixed statistics");
  const oid = (await history(repo, undefined, 0, signals())).anchorOid!;
  const files = (await commitFiles(repo, oid, undefined, 0, signals())).files;
  expect(files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: next,
        oldPath: old,
        status: "R",
        additions: 1,
        deletions: 0,
      }),
      expect.objectContaining({ path: "mode.sh", additions: 0, deletions: 0 }),
      expect.objectContaining({ path: "gone.txt", status: "D", additions: 0, deletions: 2 }),
      expect.objectContaining({ path: "large.txt", additions: 70_000, deletions: 0 }),
    ]),
  );
  const diff = await commitDiff(repo, oid, undefined, "large.txt", signals());
  expect(diff.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(diff))).toBeLessThan(agentLimits.resultBytes);
  await repos.close();
}, 15_000);
test("merge parents are explicit and branches expose linked worktree occupancy", async () => {
  const { root, home, cli, repo, repos } = await setup();
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
  await expect(commitFiles(repo, merge.oid, undefined, 0, signals())).rejects.toMatchObject({
    code: "invalid_argument",
  });
  expect((await commitFiles(repo, merge.oid, merge.parents[0], 0, signals())).files).toMatchObject([
    { path: "feature", additions: 1, deletions: 0 },
  ]);
  expect((await commitFiles(repo, merge.oid, merge.parents[1], 0, signals())).files).toMatchObject([
    { path: "main", additions: 1, deletions: 0 },
  ]);
  const linked = join(home, 'linked\t路径"\\\n');
  await cli("worktree", "add", linked, "feature");
  await cli("worktree", "lock", linked);
  const list = await branches(repo, signals());
  expect(list.branches.find((item) => item.name === "feature")).toMatchObject({
    current: false,
    worktreePath: linked,
  });
  expect(list.branches.find((item) => item.name === "main")?.current).toBe(true);
  await rename(linked, join(home, "moved-linked"));
  expect(
    (await branches(repo, signals())).branches.find((item) => item.name === "feature"),
  ).toMatchObject({ worktreePath: linked });
  await repos.close();
}, 15_000);
test.each(["bare.git", ".git"])("bare %s does not occupy its HEAD branch", async (name) => {
  const { root, home, cli, repos } = await setup();
  await cli("commit", "--allow-empty", "-m", "base");
  const bare = join(home, name);
  const linked = join(home, "linked");
  await run("git", ["clone", "--bare", root, bare]);
  await run("git", ["--git-dir", bare, "worktree", "add", "-b", "linked", linked]);
  const repo = await repos.inspect(linked, home, signals());
  const list = (await branches(repo, signals())).branches;
  expect(list.find((item) => item.name === "main")?.worktreePath).toBeUndefined();
  expect(list.find((item) => item.name === "linked")?.worktreePath).toBe(linked);
  await repos.close();
});
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
