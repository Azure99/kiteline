import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
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
import { testConfig } from "./support/config.js";
import { gitRepoFixture, isolateGitEnvironment, workspaceFixture } from "./support/git.js";
import { stagePaths, unstagePaths, reviewDiscard, discard } from "../src/git/changes.js";
import { GitWriteQueue } from "../src/git/queue.js";
import { gitRead, gitWrite } from "../src/git/process.js";
import { commit, createBranch, deleteBranch, switchBranch } from "../src/git/refs.js";
import { observeIndex, headIdentity } from "../src/git/observe.js";
import { status } from "../src/git/status.js";
import { workingDiff } from "../src/git/diff.js";
import { AppError } from "@kiteline/shared/protocol";

const exec = promisify(execFile);
const roots: string[] = [];
const signal = () => new AbortController().signal;
function killTestProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
beforeEach(async () => {
  roots.push(await isolateGitEnvironment());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp("/var/tmp/kiteline-git-write-");
  roots.push(root);
  const run = await gitRepoFixture(root);
  const cli = async (...args: string[]) => (await run(...args)).stdout;
  const home = await mkdtemp("/var/tmp/kiteline-git-write-meta-");
  roots.push(home);
  const metadata = new MetadataStore(testConfig(home), () => {});
  const { workspace, repos, repo } = await workspaceFixture(root, metadata);
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
    stage: (paths: string[]) => stagePaths(repo, paths, signal()),
    unstage: (paths: string[]) => unstagePaths(repo, paths, signal()),
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
test.each(["file", "symlink", "untracked"])(
  "staging preserves scope when %s becomes a directory",
  async (kind) => {
    const { root, cli, write, stage } = await setup();
    await write("third", "base");
    if (kind === "symlink") await symlink("third", join(root, "selected"));
    else await write("selected", "base");
    await cli("add", "--", ...(kind === "untracked" ? ["third"] : ["third", "selected"]));
    await cli("commit", "-m", "base");
    if (kind === "symlink") {
      await rm(join(root, "selected"));
      await symlink("other", join(root, "selected"));
    } else await write("selected", "changed");
    await write("third", "unrelated staged content");
    await cli("add", "third");
    const actual = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
    const bin = join(root, ".git/bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
case " $* " in
  *" add -A "*)
    rm -- selected
    mkdir -- selected
    printf '%s' unselected > selected/child
    ;;
esac
exec '${actual.replaceAll("'", "'\\''")}' "$@"
`,
    );
    await chmod(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    await stage(["selected"]);
    expect(await cli("ls-files", "-z")).toBe("third\0");
    expect(await cli("show", ":third")).toBe("unrelated staged content");
    expect(await readFile(join(root, "selected/child"), "utf8")).toBe("unselected");
  },
);
test("selected repositories and linked worktrees own storage while retaining identity and hooks", async () => {
  const { root, repo, cli, repos, workspace, write } = await setup();
  const other = await setup();
  await write("base.txt", "base\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await other.write("other.txt", "other\n");
  await other.cli("add", ".");
  await other.cli("commit", "-m", "other");
  const linked = join(root, "linked");
  await cli("worktree", "add", "-b", "linked", linked);
  const hooks = join(root, "hooks");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh
git diff --cached --name-only > hook-seen
`,
  );
  await chmod(join(hooks, "pre-commit"), 0o755);
  const config = join(process.env.HOME!, ".gitconfig");
  await writeFile(config, `[core]\n\thooksPath = ${hooks}\n`);
  const cleanEnv = { ...process.env };
  const otherIndex = await readFile(join(other.root, ".git/index"));
  const otherHead = await other.cli("rev-parse", "HEAD");
  for (const [name, value] of Object.entries({
    GIT_DIR: join(other.root, ".git"),
    GIT_WORK_TREE: other.root,
    GIT_COMMON_DIR: join(other.root, ".git"),
    GIT_INDEX_FILE: join(other.root, ".git/index"),
    GIT_OBJECT_DIRECTORY: join(other.root, ".git/objects"),
    GIT_CONFIG_GLOBAL: config,
    GIT_AUTHOR_NAME: "Selected Author",
    GIT_AUTHOR_EMAIL: "selected@example.test",
  }))
    vi.stubEnv(name, value);
  try {
    const found = await repos.discover(workspace.id, undefined, signal());
    expect(found.complete).toBe(true);
    const linkedRepo = found.repos.find((candidate) => candidate.rootPath === linked)!;
    expect(found.repos.find((candidate) => candidate.id === repo.id)).toBeDefined();
    expect(linkedRepo.commonDir).toBe(repo.commonDir);
    expect(linkedRepo.gitDir).not.toBe(repo.gitDir);
    for (const selected of [repo, linkedRepo]) {
      await writeFile(join(selected.rootPath, "selected.txt"), selected.rootPath + "\n");
      expect(
        (await status(selected, 0, undefined, signal())).entries.some(
          (entry) => entry.path === "selected.txt",
        ),
      ).toBe(true);
      await stagePaths(selected, ["selected.txt"], signal());
      await commit(selected, "selected", (await observeIndex(selected, signal())).token, signal());
      const actual = await exec("git", ["log", "-1", "--format=%an <%ae>: %s"], {
        cwd: selected.rootPath,
        env: cleanEnv,
      });
      expect(actual.stdout).toBe("Selected Author <selected@example.test>: selected\n");
      expect(await readFile(join(selected.rootPath, "hook-seen"), "utf8")).toBe("selected.txt\n");
    }
    expect(await readFile(join(other.root, ".git/index"))).toEqual(otherIndex);
    expect(
      (await exec("git", ["rev-parse", "HEAD"], { cwd: other.root, env: cleanEnv })).stdout,
    ).toBe(otherHead);
  } finally {
    await repos.close();
    await other.repos.close();
  }
});
test.each(["stage", "unstage", "discard"])(
  "%s blocks an unselected non-UTF-8 index descendant before writing",
  async (kind) => {
    const { root, cli, repo, write, stage, unstage } = await setup();
    await cli("config", "status.renames", "false");
    await write("a", "original parent\n");
    await write("third", "unselected\n");
    await cli("add", ".");
    await cli("commit", "-m", "base");
    await rm(join(root, "a"));
    await mkdir(join(root, "a"));
    const bad = Buffer.concat([Buffer.from(root + "/a/"), Buffer.from([0xff])]);
    await writeFile(bad, "unselected child\n");
    await cli("add", "-A");
    await rm(join(root, "a"), { recursive: true });
    if (kind === "stage") await write("a", "replacement parent\n");
    const before = (
      await exec("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "buffer" })
    ).stdout;
    await expect(
      kind === "stage"
        ? stage(["a"])
        : kind === "unstage"
          ? unstage(["a"])
          : reviewDiscard(repo, ["a"], "all", signal()),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { blockedPaths: [], invalidPaths: ["\\x61\\x2f\\xff"] },
    });
    expect(
      (await exec("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "buffer" })).stdout,
    ).toEqual(before);
    expect(await readFile(join(root, "third"), "utf8")).toBe("unselected\n");
    if (kind === "stage")
      expect(await readFile(join(root, "a"), "utf8")).toBe("replacement parent\n");
  },
);
test("legal replacement-character names can be staged and discarded beside invalid names", async () => {
  const { root, cli, repo, write, stage, unstage } = await setup();
  await write("\uFFFD", "valid\n");
  const bad = Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff])]);
  await writeFile(bad, "invalid\n");
  await cli("add", ".");
  await commit(repo, "base", (await observeIndex(repo, signal())).token, signal());
  expect((await status(repo, 0, undefined, signal())).stagedCount).toBe(0);
  await write("\uFFFD", "changed\n");
  await stage(["\uFFFD"]);
  expect(await cli("show", ":\uFFFD")).toBe("changed\n");
  await unstage(["\uFFFD"]);
  const review = await reviewDiscard(repo, ["\uFFFD"], "worktree", signal());
  await discard(repo, review.paths, "worktree", review.reviewToken, signal());
  expect(await readFile(join(root, "\uFFFD"), "utf8")).toBe("valid\n");
  expect(await readFile(bad, "utf8")).toBe("invalid\n");
  await rm(join(root, "\uFFFD"));
  await mkdir(join(root, "\uFFFD"));
  await writeFile(Buffer.concat([Buffer.from(root + "/\uFFFD/"), Buffer.from([0xe9])]), "child");
  await expect(reviewDiscard(repo, ["\uFFFD"], "worktree", signal())).rejects.toMatchObject({
    code: "conflict",
    details: { blockedPaths: ["\uFFFD"], invalidPaths: ["\\xef\\xbf\\xbd\\x2f\\xe9"] },
  });
});
test.each([
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
])("selected paths and hooks retain their matching rules with inherited %s", async (variable) => {
  const { root, repo, cli, write, stage, unstage } = await setup();
  const path = "literal[*]\nfile.txt";
  await write(path, "base\n");
  await write("unselected.txt", "base\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await write(
    ".git/hooks/post-index-change",
    `#!/bin/sh
git diff --cached --name-only -z -- '*.txt' > .git/hook-files
`,
  );
  await chmod(join(root, ".git/hooks/post-index-change"), 0o755);
  await write(
    ".git/hooks/pre-commit",
    `#!/bin/sh
if test -n "$(git diff --cached --name-only -- '*.txt')"; then
  echo hook-rejected >&2
  exit 1
fi
`,
  );
  await chmod(join(root, ".git/hooks/pre-commit"), 0o755);
  await write(path, "changed\n");
  await write("unselected.txt", "not selected\n");
  await write("LITERAL[*]\nfile.txt", "unselected case variant\n");
  vi.stubEnv(variable, "1");
  await stage([path]);
  expect(await readFile(join(root, ".git/hook-files"), "utf8")).toBe(path + "\0");
  await expect(
    commit(repo, "blocked", (await observeIndex(repo, signal())).token, signal()),
  ).rejects.toThrow("hook-rejected");
  expect(await cli("log", "-1", "--format=%s")).toBe("base\n");
  await stage(["unselected.txt"]);
  await unstage([path]);
  expect(await readFile(join(root, ".git/hook-files"), "utf8")).toBe("unselected.txt\0");
  const review = await reviewDiscard(repo, [path], "worktree", signal());
  await discard(repo, review.paths, "worktree", review.reviewToken, signal());
  expect(await readFile(join(root, path), "utf8")).toBe("base\n");
  expect(await readFile(join(root, "unselected.txt"), "utf8")).toBe("not selected\n");
  expect(await cli("show", ":unselected.txt")).toBe("not selected\n");
});
test("copy diff, unstage and discard leave independent source changes intact", async () => {
  const { root, repo, cli, write, stage, unstage } = await setup();
  const original = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
  await write("source.txt", original);
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await cli("config", "status.renames", "copies");
  await write("copy.txt", original);
  await write("source.txt", original + "source staged change\n");
  await stage(["copy.txt", "source.txt"]);
  const before = await status(repo, 0, undefined, signal());
  expect(before.entries.find((entry) => entry.path === "copy.txt")).toMatchObject({
    indexStatus: "C",
    oldPath: "source.txt",
  });
  const patch = await workingDiff(repo, "copy.txt", "staged", signal());
  expect(patch.patch).toContain("+line 99");
  expect(patch.patch).not.toContain("source staged change");
  await unstage(["copy.txt"]);
  expect(await cli("diff", "--cached", "--name-only")).toBe("source.txt\n");
  await stage(["copy.txt"]);
  const review = await reviewDiscard(repo, ["copy.txt"], "all", signal());
  expect(review.paths).toEqual(["copy.txt"]);
  await discard(repo, review.paths, "all", review.reviewToken, signal());
  await expect(readFile(join(root, "copy.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "source.txt"), "utf8")).toBe(
    original + "source staged change\n",
  );
  expect(await cli("show", ":source.txt")).toBe(original + "source staged change\n");
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
test("exact index actions allow related removals in the same batch and preserve sibling prefixes", async () => {
  const { root, cli, write, stage, unstage } = await setup();
  await write("config", "old file");
  await write("config-other/deep/file", "independent");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await write("config-other/deep/file", "independent staged change");
  await stage(["config-other/deep/file"]);
  await rm(join(root, "config"));
  await write("config/deep/file", "new child");
  await expect(stage(["config/deep/file"])).rejects.toMatchObject({
    details: { blockedPaths: ["config"] },
  });
  await stage(["config", "config/deep/file"]);
  expect(await cli("show", ":config/deep/file")).toBe("new child");
  await expect(unstage(["config"])).rejects.toMatchObject({
    details: { blockedPaths: ["config/deep/file"] },
  });
  await unstage(["config", "config/deep/file"]);
  expect(await cli("diff", "--cached", "--name-only")).toBe("config-other/deep/file\n");
  expect(await cli("show", ":config-other/deep/file")).toBe("independent staged change");
});
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
  const beforeIndex = await cli("ls-files", "--stage", "-z");
  const beforeNew = await readFile(join(root, "new"));
  await expect(discard(repo, all.paths, "all", all.reviewToken, signal())).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await cli("ls-files", "--stage", "-z")).toBe(beforeIndex);
  expect(await readFile(join(root, "new"))).toEqual(beforeNew);
  expect(await readFile(join(root, "old"), "utf8")).toBe("changed after review");
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
test("queued writes recheck identity after acquiring the gate without registering a replacement", async () => {
  const { root, repo, repos, workspace } = await setup();
  const parked = await mkdtemp("/var/tmp/kiteline-git-queued-");
  roots.push(parked);
  const queue = new GitWriteQueue(repos);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = queue.run(workspace.id, repo.id, signal(), async () => {
    entered();
    await gate;
  });
  const operation = vi.fn(async () => {});
  let waiting: Promise<void> | undefined;
  try {
    await Promise.race([started, held]);
    waiting = queue.run(workspace.id, repo.id, signal(), operation);
    const rejected = expect(waiting).rejects.toMatchObject({ code: "conflict" });
    await rename(join(root, ".git"), join(parked, ".git"));
    await gitRepoFixture(root);
    const replacement = await repos.inspect(root, root, signal());
    expect(replacement.id).not.toBe(repo.id);
    release();
    await held;
    await rejected;
    expect(operation).not.toHaveBeenCalled();
    expect(repos.known.get(repo.id)).toEqual(repo);
    await expect(repos.resolve(workspace.id, replacement.id, signal())).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    release();
    await Promise.allSettled([held, waiting]);
    await repos.close();
  }
});

test("write queue cancellation is prompt, preserves ordering and bounded output never kills writes", async () => {
  const { root, repo, repos, workspace, cli, write } = await setup();
  await write("base", "base");
  await cli("add", ".");
  await write(
    ".git/hooks/pre-commit",
    `#!/bin/sh
seq 1 10000
sleep 0.2
`,
  );
  await exec("chmod", ["+x", join(root, ".git/hooks/pre-commit")]);
  const queue = new GitWriteQueue(repos);
  const first = queue.run(workspace.id, repo.id, signal(), () =>
    gitWrite(root, ["commit", "-m", "base"], signal()),
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

test("write startup failure is failed while native rejection after startup is unknown", async () => {
  const { root, cli } = await setup();
  await expect(
    gitWrite(join(root, "missing-directory"), ["tag", "not-started"], signal()),
  ).rejects.toMatchObject({ code: "not_found", outcome: "failed" });
  await expect(
    gitWrite(root, ["tag", "not-created", "missing-commit"], signal()),
  ).rejects.toMatchObject({
    code: "io_error",
    outcome: "unknown",
    result: {
      stdout: "",
      stderr: expect.stringContaining("missing-commit"),
      truncated: false,
      exitCode: 128,
    },
  });
  expect(await cli("tag", "--list")).toBe("");
});

test("a newly started credential cache survives completion and releases the write queue", async () => {
  const { root, cli, repo, repos, workspace } = await setup();
  const socket = join(root, ".git/credential-cache/socket");
  const input = "protocol=https\nhost=example.test\nusername=test\npassword=synthetic\n\n";
  await cli("commit", "--allow-empty", "-m", "base");
  const queue = new GitWriteQueue(repos);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("cache blocked completion")), 2000);
  try {
    const first = queue.run(workspace.id, repo.id, controller.signal, () =>
      gitWrite(
        root,
        ["-c", `credential.helper=cache --timeout=30 --socket=${socket}`, "credential", "approve"],
        controller.signal,
        { input },
      ),
    );
    const next = queue.run(workspace.id, repo.id, controller.signal, () =>
      gitWrite(root, ["tag", "after-cache"], controller.signal),
    );
    await Promise.all([first, next]);
    clearTimeout(timeout);
    controller.abort(new Error("operation already completed"));
    const credential = await gitRead(
      root,
      ["credential-cache", `--socket=${socket}`, "get"],
      signal(),
      {
        input: "protocol=https\nhost=example.test\n\n",
      },
    );
    expect(credential.text).toContain("password=synthetic");
    expect(await cli("tag", "--list")).toBe("after-cache\n");
  } finally {
    clearTimeout(timeout);
    await cli("credential-cache", `--socket=${socket}`, "exit");
  }
});

test("Git waits for a synchronous hook but leaves its background task running", async () => {
  const { root, cli, repo, repos, workspace, write } = await setup();
  let background: number | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("background blocked completion")),
    2500,
  );
  try {
    await write(
      ".git/hooks/post-commit",
      `#!/bin/sh
sleep 0.1
echo synchronous > .git/sync-done
sleep 30 </dev/null >/dev/null 2>&1 &
echo $! > .git/background.pid
`,
    );
    await chmod(join(root, ".git/hooks/post-commit"), 0o755);
    const queue = new GitWriteQueue(repos);
    const first = queue.run(workspace.id, repo.id, controller.signal, () =>
      gitWrite(root, ["commit", "--allow-empty", "-m", "hook"], controller.signal),
    );
    const next = queue.run(workspace.id, repo.id, controller.signal, async () => {
      expect(await readFile(join(root, ".git/sync-done"), "utf8")).toBe("synchronous\n");
      background = Number(await readFile(join(root, ".git/background.pid"), "utf8"));
      expect(process.kill(background, 0)).toBe(true);
      return gitWrite(root, ["tag", "after-background"], controller.signal);
    });
    await Promise.all([first, next]);
    expect(await cli("tag", "--list")).toBe("after-background\n");
  } finally {
    clearTimeout(timeout);
    background ??= Number(await readFile(join(root, ".git/background.pid"), "utf8"));
    killTestProcess(background);
  }
});

test("Git collects delayed hook output within the output drain deadline", async () => {
  const { root, write } = await setup();
  await write(
    ".git/hooks/post-commit",
    `#!/bin/sh
(
  sleep 0.1
  echo delayed-hook-output >&2
) &
`,
  );
  await chmod(join(root, ".git/hooks/post-commit"), 0o755);
  const result = await gitWrite(root, ["commit", "--allow-empty", "-m", "output"], signal());
  expect(result).toEqual({
    stdout: expect.any(String),
    stderr: expect.stringContaining("delayed-hook-output"),
    truncated: false,
  });
});

test.each(["", "setsid "])(
  "a background hook (%s) holding output pipes reports unknown",
  async (prefix) => {
    const { root, cli, repo, repos, workspace, write } = await setup();
    let escaped: number | undefined;
    try {
      await write("file", "value");
      await cli("add", "file");
      await write(
        ".git/hooks/post-commit",
        `#!/bin/sh
${prefix}sh -c '
  echo $$ > .git/escaped.pid
  exec sleep 30
' &
`,
      );
      await chmod(join(root, ".git/hooks/post-commit"), 0o755);
      const queue = new GitWriteQueue(repos);
      const result = queue.run(workspace.id, repo.id, signal(), () =>
        gitWrite(root, ["commit", "-m", "committed"], signal()),
      );
      const rejected = expect(result).rejects.toMatchObject({
        outcome: "unknown",
        message: expect.stringContaining("pipes did not close"),
      });
      await expect
        .poll(async () => {
          escaped = Number(await readFile(join(root, ".git/escaped.pid"), "utf8"));
          return escaped;
        })
        .toBeGreaterThan(0);
      await rejected;
      expect(await cli("log", "-1", "--format=%s")).toBe("committed\n");
      await queue.run(workspace.id, repo.id, signal(), () =>
        gitWrite(root, ["tag", "after-hook"], signal()),
      );
      expect(process.kill(escaped!, 0)).toBe(true);
    } finally {
      if (escaped) killTestProcess(escaped);
    }
  },
);

test.each(["cancelled", "timeout"] as const)(
  "%s stops a detached-output hook before releasing the write queue",
  async (reason) => {
    const { root, repo, repos, workspace, cli, write } = await setup();
    await write("base", "base");
    await cli("add", ".");
    await write(
      ".git/hooks/pre-commit",
      `#!/bin/sh
trap '' TERM
exec >/dev/null 2>&1
echo $PPID $$ >.git/hook-ready
sleep 2
echo leaked >.git/hook-leaked
`,
    );
    await exec("chmod", ["+x", join(root, ".git/hooks/pre-commit")]);
    const queue = new GitWriteQueue(repos);
    const controller = new AbortController();
    const running = queue.run(workspace.id, repo.id, controller.signal, () =>
      gitWrite(root, ["commit", "-m", "cancel"], controller.signal),
    );
    const assertion = expect(running).rejects.toMatchObject({ code: reason, outcome: "unknown" });
    let group: number | undefined;
    let hook: number | undefined;
    try {
      for (let i = 0; ; i++) {
        try {
          [group, hook] = (await readFile(join(root, ".git/hook-ready"), "utf8"))
            .trim()
            .split(/\s+/)
            .map(Number);
          if (group && group > 0 && hook && hook > 0) break;
          throw new Error("Hook readiness has not reported both process IDs");
        } catch (error) {
          if (i === 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      controller.abort(new AppError(reason, "Stop test Git operation"));
      await assertion;
      await rm(join(root, ".git/hooks/pre-commit"));
      await queue.run(workspace.id, repo.id, signal(), async () => {
        const state = await exec("ps", ["-p", String(hook), "-o", "stat="]).catch((error) => {
          if (error.code !== 1) throw error;
          return { stdout: "" };
        });
        expect(state.stdout.trim()).toMatch(/^(Z.*)?$/);
        return gitWrite(root, ["commit", "-m", "next"], signal());
      });
      await expect(readFile(join(root, ".git/hook-leaked"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await cli("log", "-1", "--format=%s")).toBe("next\n");
    } finally {
      controller.abort(new AppError("cancelled", "Clean up test Git operation"));
      await Promise.allSettled([running, assertion]);
      if (group) killTestProcess(-group);
    }
  },
);

test("cancellation during output drain still cleans the group before the next write", async () => {
  const { root, repo, repos, workspace, write } = await setup();
  await write(
    ".git/hooks/post-commit",
    `#!/bin/sh
echo $PPID > .git/git.pid
sh -c '
  trap "" TERM
  echo $$ > .git/background.pid
  exec sleep 30
' &
`,
  );
  await chmod(join(root, ".git/hooks/post-commit"), 0o755);
  const queue = new GitWriteQueue(repos);
  const controller = new AbortController();
  const running = queue.run(workspace.id, repo.id, controller.signal, () =>
    gitWrite(root, ["commit", "--allow-empty", "-m", "draining"], controller.signal),
  );
  const assertion = expect(running).rejects.toMatchObject({
    code: "cancelled",
    outcome: "unknown",
  });
  let group: number | undefined;
  let background: number | undefined;
  try {
    await expect
      .poll(async () => {
        group = Number(await readFile(join(root, ".git/git.pid"), "utf8"));
        background = Number(await readFile(join(root, ".git/background.pid"), "utf8"));
        if (!group || !background) return false;
        try {
          process.kill(group, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          return true;
        }
      })
      .toBe(true);
    const next = queue.run(workspace.id, repo.id, signal(), async () => {
      const state = await exec("ps", ["-p", String(background), "-o", "stat="]).catch((error) => {
        if (error.code !== 1) throw error;
        return { stdout: "" };
      });
      expect(state.stdout.trim()).toMatch(/^(Z.*)?$/);
      return gitWrite(root, ["tag", "after-drain-cancel"], signal());
    });
    controller.abort(new AppError("cancelled", "cancel while draining"));
    await Promise.all([assertion, next]);
  } finally {
    controller.abort(new AppError("cancelled", "Clean up test Git operation"));
    await Promise.allSettled([running, assertion]);
    if (group) killTestProcess(-group);
  }
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
  await write(
    ".git/hooks/pre-commit",
    `#!/bin/sh
echo hook-rejected >&2
exit 1
`,
  );
  await exec("chmod", ["+x", join(root, ".git/hooks/pre-commit")]);
  await expect(
    commit(repo, "rejected", (await observeIndex(repo, signal())).token, signal()),
  ).rejects.toThrow("hook-rejected");
  expect((await headIdentity(root, signal())).oid).toBe(result.commitOid);
  expect(await cli("diff", "--cached", "--name-only")).toBe("one\n");
});
test("a completed commit retains its known fact when readback finds an unborn HEAD", async () => {
  const { root, repo, cli, write } = await setup();
  await write("file", "committed content\n");
  await cli("add", "file");
  const token = (await observeIndex(repo, signal())).token;
  const actualGit = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const bin = join(root, ".git/bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
case " $* " in
  *" commit -F - "*)
    ${quote(actualGit)} "$@" || exit $?
    exec ${quote(actualGit)} symbolic-ref HEAD refs/heads/readback-missing
    ;;
  *) exec ${quote(actualGit)} "$@" ;;
esac
`,
  );
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  try {
    await expect(commit(repo, "written", token, signal())).rejects.toMatchObject({
      outcome: "unknown",
      code: "io_error",
      message: expect.stringContaining("HEAD is unreadable"),
      result: { committed: true },
    });
    expect(await cli("log", "main", "-1", "--format=%s")).toBe("written\n");
    expect(await cli("show", "main:file")).toBe("committed content\n");
  } finally {
    await cli("symbolic-ref", "HEAD", "refs/heads/main");
  }
});

test("commit rejects an external branch change during its observation", async () => {
  const { root, repo, cli, write } = await setup();
  await write("x", "base x\n");
  await write("y", "main\n");
  await cli("add", ".");
  await cli("commit", "-m", "main");
  await cli("checkout", "-b", "other");
  await write("y", "other\n");
  await cli("commit", "-am", "other");
  const other = (await cli("rev-parse", "HEAD")).trim();
  await cli("checkout", "main");
  await write("x", "staged x\n");
  await cli("add", "x");
  const token = (await observeIndex(repo, signal())).token;
  const actual = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const release = join(root, ".git/release");
  const ready = join(root, ".git/ready");
  const bin = await mkdtemp("/var/tmp/kiteline-git-gate-");
  roots.push(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
case " $* " in
  *" diff --cached "*)
    : > ${quote(ready)}
    while [ ! -e ${quote(release)} ]; do
      sleep 0.01
    done
    ;;
esac
exec ${quote(actual)} "$@"
`,
  );
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  const controller = new AbortController();
  const pending = commit(repo, "must not commit", token, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "conflict" });
  try {
    for (let i = 0; ; i++) {
      try {
        await readFile(ready);
        break;
      } catch (error) {
        if (i === 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await cli("checkout", "other");
    await writeFile(release, "");
    await rejected;
    expect((await cli("rev-parse", "HEAD")).trim()).toBe(other);
    expect(await cli("show", ":y")).toBe("other\n");
    expect(await cli("show", ":x")).toBe("staged x\n");
  } finally {
    await writeFile(release, "");
    controller.abort();
    await pending.catch(() => {});
  }
});
test("index observations retain unmerged stage identities and commit refuses them", async () => {
  const { repo, cli, write } = await setup();
  await write("a", "base\n");
  await write("b", "other\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  const one = (await cli("rev-parse", "HEAD:a")).trim(),
    two = (await cli("rev-parse", "HEAD:b")).trim();
  const conflict = async (ours: string) =>
    gitWrite(repo.rootPath, ["update-index", "--index-info"], signal(), {
      input: `0 ${"0".repeat(40)}\ta\n100644 ${one} 1\ta\n100644 ${ours} 2\ta\n100644 ${two} 3\ta\n`,
    });
  await conflict(one);
  const before = await observeIndex(repo, signal());
  expect(before.hasConflicts).toBe(true);
  await write("a", "unstaged conflict resolution\n");
  expect((await observeIndex(repo, signal())).token).toBe(before.token);
  await conflict(two);
  const after = await observeIndex(repo, signal());
  expect(after.hasConflicts).toBe(true);
  expect(after.token).not.toBe(before.token);
  expect((await status(repo, 0, undefined, signal())).indexToken).toBeUndefined();
  await expect(commit(repo, "unresolved", after.token, signal())).rejects.toThrow(
    "unresolved conflicts",
  );
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
  await expect(deleteBranch(repo, "topic", first, signal())).rejects.toMatchObject({
    code: "conflict",
  });
  await switchBranch(repo, "main", first, signal());
  await expect(deleteBranch(repo, "topic", second, signal())).rejects.toThrow("not fully merged");
  const linked = await mkdtemp("/var/tmp/kiteline-git-write-linked-");
  roots.push(linked);
  await cli("worktree", "add", linked, "topic");
  await expect(switchBranch(repo, "topic", second, signal())).rejects.toThrow(linked);
  expect((await headIdentity(root, signal())).symbolicRef).toBe("refs/heads/main");
  await createBranch(repo, "removable", first, false, signal());
  expect(await deleteBranch(repo, "removable", first, signal())).toEqual({
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
  await write(
    ".git/hooks/post-checkout",
    `#!/bin/sh
echo checkout-hook-failed >&2
exit 1
`,
  );
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

test("unstaging only the new rename path preserves the old deletion and both disk contents", async () => {
  const { root, cli, write, unstage } = await setup();
  await write("old", "one\ntwo\nthree\n");
  await cli("add", "old");
  await cli("commit", "-m", "base");
  await cli("mv", "old", "new");
  await write("old", "independent old content\n");
  await unstage(["new"]);
  expect(await cli("diff", "--cached", "--name-status")).toBe("D\told\n");
  expect(await cli("ls-files", "--", "old", "new")).toBe("");
  expect(await readFile(join(root, "new"), "utf8")).toBe("one\ntwo\nthree\n");
  expect(await readFile(join(root, "old"), "utf8")).toBe("independent old content\n");
});

test("stage resolves an ordinary conflict from disk while unstage restores HEAD without changing disk", async () => {
  const { root, cli, write, stage, unstage } = await setup();
  await write("file", "base\n");
  await cli("add", "file");
  await cli("commit", "-m", "base");
  await cli("checkout", "-b", "topic");
  await write("file", "topic\n");
  await cli("commit", "-am", "topic");
  await cli("checkout", "main");
  await write("file", "main\n");
  await cli("commit", "-am", "main");
  await expect(cli("merge", "topic")).rejects.toMatchObject({ code: 1 });
  await write("file", "resolved on disk\n");
  await stage(["file"]);
  expect(await cli("ls-files", "--unmerged")).toBe("");
  expect(await cli("show", ":file")).toBe("resolved on disk\n");
  await unstage(["file"]);
  expect(await cli("show", ":file")).toBe("main\n");
  expect(await readFile(join(root, "file"), "utf8")).toBe("resolved on disk\n");
  await cli("merge", "--abort");
  await cli("checkout", "--", "file");
  await expect(cli("merge", "topic")).rejects.toMatchObject({ code: 1 });
  const disk = await readFile(join(root, "file"), "utf8");
  await unstage(["file"]);
  expect(await cli("ls-files", "--unmerged")).toBe("");
  expect(await cli("show", ":file")).toBe("main\n");
  expect(await readFile(join(root, "file"), "utf8")).toBe(disk);
});

test("discard all restores a conflicted file to HEAD while worktree scope refuses it", async () => {
  const { root, cli, repo, write, stage } = await setup();
  await write("file", "base\n");
  await write("other", "base\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await cli("checkout", "-b", "topic");
  await write("file", "topic\n");
  await cli("commit", "-am", "topic");
  await cli("checkout", "main");
  await write("file", "main\n");
  await cli("commit", "-am", "main");
  await expect(cli("merge", "topic")).rejects.toMatchObject({ code: 1 });
  await write("other", "unselected staged\n");
  await stage(["other"]);
  await write("other", "unselected disk\n");
  const index = await cli("ls-files", "--stage", "-z");
  const conflicted = await readFile(join(root, "file"));
  await expect(reviewDiscard(repo, ["file"], "worktree", signal())).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(await cli("ls-files", "--stage", "-z")).toBe(index);
  expect(await readFile(join(root, "file"))).toEqual(conflicted);
  const review = await reviewDiscard(repo, ["file"], "all", signal());
  expect(review.paths).toEqual(["file"]);
  expect(review.summary).toEqual([{ path: "file", action: "restore" }]);
  await discard(repo, review.paths, "all", review.reviewToken, signal());
  expect(await cli("ls-files", "--unmerged")).toBe("");
  expect(await cli("show", ":file")).toBe("main\n");
  expect(await readFile(join(root, "file"), "utf8")).toBe("main\n");
  expect(await cli("show", ":other")).toBe("unselected staged\n");
  expect(await readFile(join(root, "other"), "utf8")).toBe("unselected disk\n");
});

test("stage reports only the confirmed removal when a required clean filter rejects add", async () => {
  const { root, cli, write, stage } = await setup();
  await write("old", "remove me\n");
  await write("third", "keep staged\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  await write("third", "unrelated staged content\n");
  await cli("add", "third");
  await rm(join(root, "old"));
  await write("new", "filter must reject\n");
  await write(".git/info/attributes", "new filter=reject\n");
  await cli("config", "filter.reject.clean", "false");
  await cli("config", "filter.reject.required", "true");
  await expect(stage(["old", "new"])).rejects.toMatchObject({
    outcome: "partial",
    result: { changedPaths: ["old"] },
  });
  expect(await cli("ls-files", "-z")).toBe("third\0");
  expect(await cli("show", ":third")).toBe("unrelated staged content\n");
  expect(await readFile(join(root, "new"), "utf8")).toBe("filter must reject\n");
});
