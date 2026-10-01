import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "@kiteline/shared/protocol";
import { MetadataStore } from "../src/metadata.js";
import { CursorBudget } from "../src/cursor-budget.js";
import { defaultAgentLimits } from "../src/config.js";
import { Repositories } from "../src/git/repos.js";
import { headIdentity, status } from "../src/git/status.js";
import { finishOperation } from "../src/git/operation.js";
import { remotes, syncRemote } from "../src/git/remotes.js";
import { git } from "../src/git/process.js";

const exec = promisify(execFile),
  roots: string[] = [];
const signal = () => new AbortController().signal;
beforeEach(async () => {
  const home = await mkdtemp("/var/tmp/kiteline-git-env-");
  roots.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp("/var/tmp/kiteline-git-sync-");
  roots.push(home);
  const root = join(home, "project");
  await mkdir(root);
  const cli = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout;
  await cli("init");
  await cli("symbolic-ref", "HEAD", "refs/heads/main");
  await cli("config", "user.name", "Kiteline Test");
  await cli("config", "user.email", "kiteline@example.test");
  const metadata = new MetadataStore({
    dataDir: home,
    runDir: join(home, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits },
  });
  const workspace = await metadata.add(root),
    repos = new Repositories(metadata, new CursorBudget());
  const repo = (await repos.discover(workspace.id, undefined, signal())).repos[0]!;
  const write = (path: string, text: string) => writeFile(join(root, path), text);
  await write("f", "base\n");
  await write("g", "base\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  return { root, home, cli, write, repo };
}
async function operation(repo: Repo) {
  return (await status(repo, 0, undefined, signal())).operation!;
}
async function divergent() {
  const value = await setup(),
    { cli, write } = value;
  await cli("switch", "-c", "topic");
  await write("f", "topic one\n");
  await cli("commit", "-am", "one with exec in subject");
  const first = (await cli("rev-parse", "HEAD")).trim();
  await write("g", "topic two\n");
  await cli("commit", "-am", "two");
  const second = (await cli("rev-parse", "HEAD")).trim();
  await cli("switch", "main");
  await write("f", "main one\n");
  await write("g", "main two\n");
  await cli("commit", "-am", "main");
  return { ...value, first, second };
}
test("merge token binds its native target, survives staging, and continues through Git", async () => {
  const { repo, root, cli, write } = await divergent();
  await expect(cli("merge", "topic")).rejects.toThrow();
  const conflict = await operation(repo);
  expect(conflict).toMatchObject({ kind: "merge", canContinue: false, canAbort: true });
  const marker = await readFile(join(repo.gitDir, "MERGE_HEAD"));
  await writeFile(join(repo.gitDir, "MERGE_HEAD"), (await headIdentity(root, signal())).oid!);
  await expect(
    finishOperation(repo, "merge", conflict.token!, "abort", signal()),
  ).rejects.toMatchObject({ code: "conflict" });
  await writeFile(join(repo.gitDir, "MERGE_HEAD"), marker);
  const current = await operation(repo);
  await write("f", "resolved one\n");
  await write("g", "resolved two\n");
  await cli("add", "f", "g");
  const ready = await operation(repo);
  expect(ready.token).toBe(current.token);
  expect(ready.canContinue).toBe(true);
  const result = await finishOperation(repo, "merge", ready.token!, "continue", signal());
  expect(result.operationAfter).toBeUndefined();
  expect(result.headOid).toBe((await headIdentity(root, signal())).oid);
});
test.each(["--merge", "--apply"])(
  "ordinary rebase %s can continue through consecutive conflicts",
  async (backend) => {
    const { repo, cli, write } = await divergent();
    await cli("switch", "topic");
    await expect(
      cli("rebase", ...(backend === "--apply" ? ["--whitespace=nowarn"] : [backend]), "main"),
    ).rejects.toThrow();
    const first = await operation(repo);
    expect(first.kind).toBe("rebase");
    await write("f", "resolved one\n");
    await cli("add", "f");
    const ready = await operation(repo);
    expect(ready.token).toBe(first.token);
    expect(ready.canContinue).toBe(true);
    await expect(
      finishOperation(repo, "rebase", ready.token!, "continue", signal()),
    ).rejects.toMatchObject({ outcome: "partial", result: { operationAfter: { kind: "rebase" } } });
    const second = await operation(repo);
    expect(second.token).not.toBe(first.token);
    await expect(
      finishOperation(repo, "rebase", first.token!, "abort", signal()),
    ).rejects.toMatchObject({ code: "conflict" });
    await write("g", "resolved two\n");
    await cli("add", "g");
    const done = await finishOperation(repo, "rebase", second.token!, "continue", signal());
    expect(done.operationAfter).toBeUndefined();
  },
);
test("special rebase steps disable only continue and custom comments are honored", async () => {
  const { repo, root, cli, write } = await divergent();
  await cli("config", "core.commentChar", ";");
  await cli("switch", "topic");
  await expect(cli("rebase", "--merge", "main")).rejects.toThrow();
  const todo = join(repo.gitDir, "rebase-merge/git-rebase-todo");
  const original = await readFile(todo, "utf8");
  await writeFile(
    todo,
    " \t; comment\r\n" + original.replace(/^pick /gm, "\tp ").replace(/\n/g, "\r\n"),
  );
  await write("f", "resolved\n");
  await cli("add", "f");
  expect((await operation(repo)).canContinue).toBe(true);
  await writeFile(todo, original + "exec true\n");
  const special = await operation(repo);
  expect(special).toMatchObject({ kind: "rebase", canContinue: false, canAbort: true });
  await expect(
    finishOperation(repo, "rebase", special.token!, "continue", signal()),
  ).rejects.toMatchObject({ code: "conflict" });
  await finishOperation(repo, "rebase", special.token!, "abort", signal());
  expect((await headIdentity(root, signal())).symbolicRef).toBe("refs/heads/topic");
  expect((await status(repo, 0, undefined, signal())).operation).toBeUndefined();
});
test("oversized rebase metadata is reported without enabling an unverified operation", async () => {
  const { repo, cli } = await divergent();
  await cli("switch", "topic");
  await expect(cli("rebase", "--merge", "main")).rejects.toThrow();
  await writeFile(
    join(repo.gitDir, "rebase-merge/git-rebase-todo"),
    `#${"x".repeat(128 * 1024)}\n`,
  );
  expect(await operation(repo)).toMatchObject({
    kind: "unknown",
    canContinue: false,
    canAbort: false,
    reason: expect.stringContaining("contains a line exceeding"),
  });
});
test("remote metadata follows native URL expansion and avoids claiming complex push targets", async () => {
  const { repo, cli } = await setup();
  await cli("remote", "add", "backup", "short:repo.git");
  await cli("config", "url.https://example.test/.insteadOf", "short:");
  await cli("config", "url.ssh://example.test/.pushInsteadOf", "short:");
  await cli("config", "push.default", "current");
  expect(await remotes(repo, signal())).toMatchObject({
    defaultFetchRemote: "backup",
    defaultPushRemote: "backup",
    pushTarget: "backup/main",
    remotes: [
      { fetchUrls: ["https://example.test/repo.git"], pushUrls: ["ssh://example.test/repo.git"] },
    ],
  });
  await cli("config", "remote.backup.mirror", "true");
  expect(await remotes(repo, signal())).toMatchObject({
    defaultPushRemote: "backup",
    pushTarget: undefined,
  });
});
test("sequencer-only cherry-pick remains actionable after a manual conflict commit", async () => {
  const { repo, cli, write, first, second } = await divergent();
  await expect(cli("cherry-pick", first, second)).rejects.toThrow();
  expect((await operation(repo)).kind).toBe("cherry-pick");
  await write("f", "resolved\n");
  await cli("add", "f");
  await cli("commit", "--no-edit");
  await expect(readFile(join(repo.gitDir, "CHERRY_PICK_HEAD"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const sequence = await operation(repo);
  expect(sequence).toMatchObject({ kind: "cherry-pick", canContinue: true });
  await expect(
    finishOperation(repo, "cherry-pick", sequence.token!, "continue", signal()),
  ).rejects.toMatchObject({ outcome: "partial" });
  const next = await operation(repo);
  await finishOperation(repo, "cherry-pick", next.token!, "abort", signal());
  expect((await status(repo, 0, undefined, signal())).operation).toBeUndefined();
});
test("am and revert native conflict state can be resolved or aborted", async () => {
  const { repo, root, cli, write, first, second } = await divergent();
  const otherPatch = await cli("format-patch", "-1", "--stdout", second);
  await expect(
    git(root, ["am", "--3way"], signal(), { input: otherPatch, write: true }),
  ).rejects.toThrow();
  const otherAm = await operation(repo);
  const head = await headIdentity(root, signal());
  await finishOperation(repo, "am", otherAm.token!, "abort", signal());
  const patch = await cli("format-patch", "-1", "--stdout", first);
  await expect(
    git(root, ["am", "--3way"], signal(), { input: patch, write: true }),
  ).rejects.toThrow();
  const am = await operation(repo);
  expect(am.kind).toBe("am");
  expect(await headIdentity(root, signal())).toEqual(head);
  expect(am.token).not.toBe(otherAm.token);
  await write("f", "resolved am\n");
  await cli("add", "f");
  const done = await finishOperation(repo, "am", am.token!, "continue", signal());
  expect(done.operationAfter).toBeUndefined();
  await expect(cli("revert", "--no-edit", first)).rejects.toThrow();
  const revert = await operation(repo);
  expect(revert.kind).toBe("revert");
  await finishOperation(repo, "revert", revert.token!, "abort", signal());
  expect((await status(repo, 0, undefined, signal())).operation).toBeUndefined();
});
test("fetch pull push reuse local remotes and pull strategy; queued HEAD identity includes the ref", async () => {
  const { repo, root, home, cli, write } = await setup();
  const bare = join(home, "remote.git"),
    other = join(home, "other");
  await exec("git", ["init", "--bare", bare]);
  await exec("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await cli("remote", "add", "origin", bare);
  await cli("push", "-u", "origin", "main");
  await exec("git", ["clone", bare, other]);
  const remote = async (...args: string[]) => (await exec("git", args, { cwd: other })).stdout;
  await remote("config", "user.name", "Other");
  await remote("config", "user.email", "other@example.test");
  const metadata = await remotes(repo, signal());
  expect(metadata).toMatchObject({
    upstream: "origin/main",
    defaultFetchRemote: "origin",
    defaultPushRemote: "origin",
    pushTarget: "origin/main",
  });
  await writeFile(join(other, "remote-only"), "remote\n");
  await remote("add", ".");
  await remote("commit", "-m", "remote");
  await remote("push");
  await syncRemote(repo, "fetch", { remote: "origin" }, signal());
  expect((await cli("rev-parse", "origin/main")).trim()).toBe(
    (await remote("rev-parse", "HEAD")).trim(),
  );
  await write("local-only", "local\n");
  await cli("add", ".");
  await cli("commit", "-m", "local");
  await cli("config", "pull.rebase", "false");
  await syncRemote(repo, "pull", { expectedHead: await headIdentity(root, signal()) }, signal());
  expect((await cli("rev-list", "--parents", "-n1", "HEAD")).trim().split(" ")).toHaveLength(3);
  const expected = await headIdentity(root, signal());
  await cli("switch", "-c", "same-oid");
  await expect(
    syncRemote(repo, "push", { expectedHead: expected }, signal()),
  ).rejects.toMatchObject({ code: "conflict" });
  await cli("switch", "main");
  const pushed = await syncRemote(
    repo,
    "push",
    { expectedHead: await headIdentity(root, signal()) },
    signal(),
  );
  expect(pushed.stdout).toContain("Done");
  expect((await exec("git", ["--git-dir", bare, "rev-parse", "main"])).stdout.trim()).toBe(
    (await headIdentity(root, signal())).oid,
  );
});
