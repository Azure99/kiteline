import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  readlink,
} from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../src/metadata.js";
import { CursorBudget } from "../src/cursor-budget.js";
import { defaultAgentLimits } from "../src/config.js";
import { Repositories } from "../src/git/repos.js";
import { changeIndex, reviewDiscard, discard } from "../src/git/paths.js";
import { GitWriteQueue } from "../src/git/queue.js";
import { git } from "../src/git/process.js";
import { commit, createBranch, changeBranch } from "../src/git/refs.js";
import { observeIndex, headIdentity } from "../src/git/status.js";

const exec = promisify(execFile);
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp("/var/tmp/kiteline-git-write-");
  roots.push(root);
  const cli = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout;
  await cli("init");
  await cli("symbolic-ref", "HEAD", "refs/heads/main");
  await cli("config", "user.name", "Kiteline Test");
  await cli("config", "user.email", "kiteline@example.test");
  const home = await mkdtemp("/var/tmp/kiteline-git-write-meta-");
  roots.push(home);
  const metadata = new MetadataStore({
    dataDir: home,
    runDir: join(home, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits },
  });
  const workspace = await metadata.add(root);
  const repos = new Repositories(metadata, new CursorBudget());
  const repo = (await repos.discover(workspace.id, undefined, signal())).repos[0]!;
  return {
    root,
    cli,
    repo,
    repos,
    workspace,
    write: async (path: string, content: string) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    },
    stage: (paths: string[]) => changeIndex(repo, paths, "stage", signal()),
    unstage: (paths: string[]) => changeIndex(repo, paths, "unstage", signal()),
  };
}
test("stage and unstage exact names on unborn HEAD, keeping other staged data", async () => {
  const { root, cli, repo, write, stage, unstage } = await setup();
  const name = "-file\t[abc]*\n";
  await write(name, "first");
  await write("third", "keep");
  await stage([name, "third"]);
  await unstage([name]);
  expect(await cli("ls-files", "-z")).toBe("third\0");
  expect(await readFile(join(root, name), "utf8")).toBe("first");
  await stage([name]);
  const review = await reviewDiscard(repo, [name], "all", signal());
  await discard(repo, review.paths, "all", review.reviewToken, signal());
  await expect(readFile(join(root, name))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await cli("ls-files", "-z")).toBe("third\0");
});
test.each([false, true])(
  "file/directory replacement stages and unstages by explicit leaves (%s)",
  async (directoryFirst) => {
    const { root, cli, write, stage, unstage } = await setup();
    const old = directoryFirst ? ["config/a", "config/b"] : ["config"];
    const next = directoryFirst ? ["config"] : ["config/a", "config/b"];
    for (const path of [...old, "third"]) await write(path, path);
    await cli("add", ".");
    await cli("commit", "-m", "base");
    await write("third", "staged unrelated");
    await stage(["third"]);
    const third = await cli("show", ":third");
    await rm(join(root, "config"), { recursive: true });
    for (const path of next) await write(path, "new " + path);
    await expect(stage([next[0]!])).rejects.toMatchObject({
      code: "conflict",
      details: { blockedPaths: expect.arrayContaining(old) },
    });
    for (const path of old) await stage([path]);
    for (const path of next) await stage([path]);
    await expect(unstage([old[0]!])).rejects.toMatchObject({ code: "conflict" });
    for (const path of next) await unstage([path]);
    for (const path of old) await unstage([path]);
    expect(await cli("diff", "--cached", "--name-only")).toBe("third\n");
    expect(await cli("show", ":third")).toBe(third);
    for (const path of next) expect(await readFile(join(root, path), "utf8")).toBe("new " + path);
  },
);
test("rename actions and discard token preserve independent old-path data until explicitly reviewed", async () => {
  const { root, cli, repo, write, stage, unstage } = await setup();
  await write("old", "one\ntwo\nthree\n");
  await write("third", "base");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await cli("mv", "old", "new");
  await write("new", "one\ntwo\nchanged\n");
  await write("old", "independent");
  await stage(["new"]);
  expect(await cli("show", "HEAD:old")).toBe("one\ntwo\nthree\n");
  expect(await cli("ls-files", "--", "old")).toBe("");
  await write("new", "later");
  const work = await reviewDiscard(repo, ["new"], "worktree", signal());
  await discard(repo, work.paths, "worktree", work.reviewToken, signal());
  expect(await readFile(join(root, "old"), "utf8")).toBe("independent");
  const all = await reviewDiscard(repo, ["new"], "all", signal());
  expect(all.paths).toEqual(["new", "old"]);
  await write("old", "changed after review");
  await expect(discard(repo, all.paths, "all", all.reviewToken, signal())).rejects.toMatchObject({
    code: "conflict",
  });
  const independent = await reviewDiscard(repo, ["old"], "all", signal());
  expect(independent.summary).toEqual([{ path: "old", action: "delete" }]);
  await discard(repo, independent.paths, "all", independent.reviewToken, signal());
  expect(await cli("ls-files", "--", "old")).toBe("");
  await write("old", "changed after review");
  await unstage(["new", "old"]);
  expect(await cli("diff", "--cached", "--name-only")).toBe("");
  expect(await readFile(join(root, "old"), "utf8")).toBe("changed after review");
});
test("discard blocks directories and ancestor links before changing index, unlinks only exact symlink", async () => {
  const { root, cli, repo, write } = await setup();
  await write("a/leaf", "tracked");
  await write("flat", "tracked");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await rename(join(root, "a"), join(root, "outside"));
  await symlink("outside", join(root, "a"));
  await expect(reviewDiscard(repo, ["a/leaf"], "all", signal())).rejects.toMatchObject({
    code: "conflict",
    details: { blockedPaths: ["a"] },
  });
  await rm(join(root, "flat"));
  await write("flat/unselected", "keep");
  await expect(reviewDiscard(repo, ["flat"], "all", signal())).rejects.toMatchObject({
    code: "conflict",
    details: { blockedPaths: ["flat", "flat/unselected"] },
  });
  expect(await cli("diff", "--cached", "--name-only")).toBe("");
  await symlink("outside/leaf", join(root, "loose"));
  const review = await reviewDiscard(repo, ["loose"], "worktree", signal());
  await discard(repo, review.paths, "worktree", review.reviewToken, signal());
  await expect(readlink(join(root, "loose"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "outside/leaf"), "utf8")).toBe("tracked");
  await symlink(Buffer.from([255]), join(root, "bytes-link"));
  const bytes = await reviewDiscard(repo, ["bytes-link"], "all", signal());
  await rm(join(root, "bytes-link"));
  await symlink(Buffer.from([254]), join(root, "bytes-link"));
  await expect(
    discard(repo, bytes.paths, "all", bytes.reviewToken, signal()),
  ).rejects.toMatchObject({ code: "conflict" });
});
test("write queue cancellation is prompt, preserves ordering and bounded output never kills writes", async () => {
  const { root, repo, repos, workspace, cli, write } = await setup();
  await write("base", "base");
  await cli("add", ".");
  await write(".git/hooks/pre-commit", "#!/bin/sh\nseq 1 10000\nsleep 0.2\n");
  await exec("chmod", ["+x", join(root, ".git/hooks/pre-commit")]);
  const queue = new GitWriteQueue(repos);
  const first = queue.run(workspace.id, repo.id, signal(), () =>
    git(root, ["commit", "-m", "base"], signal(), { write: true, maxBytes: 100 }),
  );
  const controller = new AbortController();
  const waiting = queue.run(workspace.id, repo.id, controller.signal, async () => {
    throw new Error("must not run");
  });
  controller.abort(new Error("cancel queued"));
  await expect(waiting).rejects.toThrow("cancel queued");
  const result = await first;
  expect(result.truncated).toBe(true);
  expect(await cli("log", "-1", "--format=%s")).toBe("base\n");
});
test("cancelling Git stops a detached-output hook before releasing the write queue", async () => {
  const { root, repo, repos, workspace, cli, write } = await setup();
  await write("base", "base");
  await cli("add", ".");
  await write(
    ".git/hooks/pre-commit",
    "#!/bin/sh\ntrap '' TERM\nexec >/dev/null 2>&1\necho ready >.git/hook-ready\nsleep 2\necho leaked >.git/hook-leaked\n",
  );
  await exec("chmod", ["+x", join(root, ".git/hooks/pre-commit")]);
  const queue = new GitWriteQueue(repos),
    controller = new AbortController();
  const running = queue.run(workspace.id, repo.id, controller.signal, () =>
    git(root, ["commit", "-m", "cancel"], controller.signal, { write: true }),
  );
  const assertion = expect(running).rejects.toMatchObject({ outcome: "unknown" });
  for (let i = 0; ; i++) {
    try {
      await readFile(join(root, ".git/hook-ready"));
      break;
    } catch (error) {
      if (i === 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  controller.abort(new Error("cancel hook"));
  await assertion;
  await rm(join(root, ".git/hooks/pre-commit"));
  await queue.run(workspace.id, repo.id, signal(), () =>
    git(root, ["commit", "-m", "next"], signal(), { write: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await expect(readFile(join(root, ".git/hook-leaked"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await cli("log", "-1", "--format=%s")).toBe("next\n");
});
test("commit observes semantic index identity and commits every staged file", async () => {
  const { root, repo, cli, write, stage } = await setup();
  await write("one", "one");
  await write("two", "two");
  await stage(["one"]);
  const old = (await observeIndex(repo, signal())).token;
  await stage(["two"]);
  await expect(commit(repo, "stale", old, signal())).rejects.toMatchObject({ code: "conflict" });
  await write("one", "not staged");
  const result = await commit(
    repo,
    "both files",
    (await observeIndex(repo, signal())).token,
    signal(),
  );
  expect(result.commitOid).toBe((await cli("rev-parse", "HEAD")).trim());
  expect(await cli("show", "HEAD:one")).toBe("one");
  expect(await cli("show", "HEAD:two")).toBe("two");
  expect(await readFile(join(root, "one"), "utf8")).toBe("not staged");
  await stage(["one"]);
  await write(".git/hooks/pre-commit", "#!/bin/sh\necho hook-rejected >&2\nexit 1\n");
  await exec("chmod", ["+x", join(root, ".git/hooks/pre-commit")]);
  await expect(
    commit(repo, "rejected", (await observeIndex(repo, signal())).token, signal()),
  ).rejects.toThrow("hook-rejected");
  expect((await headIdentity(root, signal())).oid).toBe(result.commitOid);
  expect(await cli("diff", "--cached", "--name-only")).toBe("one\n");
});
test("branch mutations check target OID and preserve native occupancy and unmerged refusals", async () => {
  const { root, repo, cli, write } = await setup();
  await write("base", "one");
  await cli("add", ".");
  await cli("commit", "-m", "one");
  const first = (await headIdentity(root, signal())).oid!;
  const created = await createBranch(repo, "topic", first, true, signal());
  expect(created.head.symbolicRef).toBe("refs/heads/topic");
  await write("base", "two");
  await cli("add", ".");
  await cli("commit", "-m", "two");
  const second = (await headIdentity(root, signal())).oid!;
  await expect(changeBranch(repo, "topic", first, "delete", signal())).rejects.toMatchObject({
    code: "conflict",
  });
  await changeBranch(repo, "main", first, "switch", signal());
  await expect(changeBranch(repo, "topic", second, "delete", signal())).rejects.toThrow(
    "not fully merged",
  );
  const linked = await mkdtemp("/var/tmp/kiteline-git-write-linked-");
  roots.push(linked);
  await cli("worktree", "add", linked, "topic");
  await expect(changeBranch(repo, "topic", second, "switch", signal())).rejects.toThrow(linked);
  expect((await headIdentity(root, signal())).symbolicRef).toBe("refs/heads/main");
  await createBranch(repo, "removable", first, false, signal());
  expect(await changeBranch(repo, "removable", first, "delete", signal())).toEqual({
    deleted: true,
  });
  await expect(createBranch(repo, "bad..name", first, false, signal())).rejects.toMatchObject({
    code: "invalid_argument",
  });
});
test("branch creation remains reported when switching would overwrite local edits", async () => {
  const { root, repo, cli, write } = await setup();
  await write("base", "old");
  await cli("add", ".");
  await cli("commit", "-m", "old");
  const first = (await headIdentity(root, signal())).oid!;
  await write("base", "new");
  await cli("add", ".");
  await cli("commit", "-m", "new");
  await write("base", "local edit");
  await expect(createBranch(repo, "old-topic", first, true, signal())).rejects.toMatchObject({
    outcome: "partial",
    result: { created: true, switched: false },
  });
  expect((await cli("rev-parse", "refs/heads/old-topic")).trim()).toBe(first);
  expect((await headIdentity(root, signal())).symbolicRef).toBe("refs/heads/main");
  expect(await readFile(join(root, "base"), "utf8")).toBe("local edit");
  await cli("restore", "base");
  await write(".git/hooks/post-checkout", "#!/bin/sh\necho checkout-hook-failed >&2\nexit 1\n");
  await exec("chmod", ["+x", join(root, ".git/hooks/post-checkout")]);
  await expect(
    createBranch(repo, "switched-with-hook-error", first, true, signal()),
  ).rejects.toMatchObject({
    outcome: "partial",
    result: {
      created: true,
      switched: true,
      head: { symbolicRef: "refs/heads/switched-with-hook-error" },
    },
  });
});
