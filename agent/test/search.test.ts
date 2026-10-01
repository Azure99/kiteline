import { agentLimits } from "../src/limits.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@kiteline/shared/protocol";
import { searchFiles } from "../src/files/search.js";
import * as paths from "../src/files/paths.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp("/var/tmp/kiteline-search-");
  roots.push(root);
  return root;
}
const signal = () => new AbortController().signal;

test.each(["name", "content"] as const)(
  "a deadline during a metadata lookup freezes %s results and stops consumption",
  async (mode) => {
    const root = await setup();
    await writeFile(join(root, "a.txt"), "needle");
    await writeFile(join(root, "b.txt"), "needle");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi.spyOn(paths, "gitMetadataPath").mockImplementation(async () => {
      enter();
      await gate;
      return false;
    });
    const controller = new AbortController();
    const searching = searchFiles(
      root,
      mode,
      mode === "name" ? "" : "needle",
      false,
      controller.signal,
    );
    try {
      await entered;
      controller.abort(new AppError("timeout", "timeout"));
      const result = await searching;
      expect(result).toEqual({ matches: [], truncated: true });
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result).toEqual({ matches: [], truncated: true });
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      release();
      controller.abort();
      await searching.catch(() => {});
    }
  },
);

test("real rg respects ignore rules, excludes metadata and directory links, and preserves literal paths", async () => {
  const root = await setup();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "hidden"), "needle");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "needle");
  await writeFile(join(root, ".visible"), "needle");
  await writeFile(join(root, "line\nname.txt"), "needle");
  await writeFile(join(root, "literal\\name.txt"), "needle");
  await writeFile(Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff])]), "needle");
  await symlink(root, join(root, "loop"));
  const names = await searchFiles(root, "name", "", false, signal());
  expect(names.matches.map((item) => item.path).sort()).toEqual([
    ".gitignore",
    ".visible",
    "line\nname.txt",
    "literal\\name.txt",
  ]);
  expect(names.truncated).toBe(true);
  const all = await searchFiles(root, "content", "needle", true, signal());
  expect(all.matches.map((item) => item.path).sort()).toEqual([
    ".visible",
    "ignored.txt",
    "line\nname.txt",
    "literal\\name.txt",
  ]);
  expect(all.truncated).toBe(true);
});

test("content results use UTF-16 highlights, base64 bodies and bounded long-line fragments", async () => {
  const root = await setup();
  await writeFile(join(root, "unicode.txt"), "前😀 -字面.* 后\n");
  const unicode = await searchFiles(root, "content", "-字面.*", false, signal());
  expect(unicode.matches).toEqual([
    { path: "unicode.txt", line: 1, text: "前😀 -字面.* 后", ranges: [[4, 9]], truncated: false },
  ]);
  await writeFile(join(root, "bytes.txt"), Buffer.from([0xff, 0x61, 0x62, 0x63, 10]));
  const bytes = await searchFiles(root, "content", "abc", false, signal());
  expect(bytes.matches[0]).toMatchObject({ text: "�abc", ranges: [[1, 4]] });
  await writeFile(join(root, "bytes.txt"), Buffer.from([0xe2, 0x82, 0x61, 0x62, 0x63, 10]));
  expect((await searchFiles(root, "content", "abc", false, signal())).matches[0]).toMatchObject({
    text: "�abc",
    ranges: [[1, 4]],
  });
  await writeFile(join(root, "long.txt"), "a".repeat(2 * 1024 * 1024) + "needle\n");
  const long = await searchFiles(root, "content", "needle", false, signal());
  expect(long.matches[0]).toMatchObject({ path: "long.txt", line: 1, truncated: true, ranges: [] });
  expect(long.matches[0]!.text!.length).toBe(agentLimits.searchLineBytes);
  expect(long.truncated).toBe(true);
  await writeFile(join(root, "many.txt"), "needle\n".repeat(agentLimits.searchMatches + 1));
  const many = await searchFiles(root, "content", "needle", false, signal());
  expect(many.matches.length).toBe(agentLimits.searchMatches);
  expect(many.truncated).toBe(true);
});

test("cancellation and deadlines stop rg and differ from no matches", async () => {
  const root = await setup();
  await writeFile(join(root, "large"), "a".repeat(16 * 1024 * 1024));
  const cancelled = new AbortController();
  const task = searchFiles(root, "content", "nothing", false, cancelled.signal);
  cancelled.abort(new AppError("cancelled", "cancelled"));
  await expect(task).rejects.toMatchObject({ code: "cancelled" });
  const expired = new AbortController();
  const timed = searchFiles(root, "content", "nothing", false, expired.signal);
  expired.abort(new AppError("timeout", "timeout"));
  expect(await timed).toEqual({ matches: [], truncated: true });
  expect(await searchFiles(root, "content", "nothing", false, signal())).toEqual({
    matches: [],
    truncated: false,
  });
});

test("quoted global excludes and escaped directory rules apply to both search modes", async () => {
  const home = await setup();
  const root = join(home, "project");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "build"));
  await writeFile(join(home, ".gitconfig"), '[core]\n excludesFile = "~/rules"\n');
  await writeFile(join(home, "rules"), "*.sql\n");
  await writeFile(join(root, ".gitignore"), "build\\/\n");
  await writeFile(join(root, "build/artifact.txt"), "needle\n");
  await writeFile(join(root, "keep.txt"), "needle\n");
  await writeFile(join(root, "drop.sql"), "needle\n");
  vi.stubEnv("HOME", home);
  for (const mode of ["name", "content"] as const) {
    const query = mode === "name" ? "." : "needle";
    const paths = (await searchFiles(root, mode, query, false, signal())).matches.map(
      (item) => item.path,
    );
    expect(paths.filter((path) => path !== ".gitignore")).toEqual(["keep.txt"]);
    const all = (await searchFiles(root, mode, query, true, signal())).matches.map(
      (item) => item.path,
    );
    expect(all.filter((path) => path !== ".gitignore").sort()).toEqual([
      "build/artifact.txt",
      "drop.sql",
      "keep.txt",
    ]);
  }
});
