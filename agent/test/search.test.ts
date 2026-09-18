import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, limits } from "@kiteline/shared/protocol";
import { searchFiles } from "../src/files/search.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp("/var/tmp/kiteline-search-");
  roots.push(root);
  return root;
}
const signal = () => new AbortController().signal;

test("real rg respects ignore rules, excludes metadata and directory links, and preserves literal paths", async () => {
  const root = await setup();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "hidden"), "needle");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "needle");
  await writeFile(join(root, ".visible"), "needle");
  await writeFile(join(root, "line\nname.txt"), "needle");
  await writeFile(Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff])]), "needle");
  await symlink(root, join(root, "loop"));
  const names = await searchFiles(root, "name", "", false, signal());
  expect(names.matches.map((item) => item.path).sort()).toEqual([
    ".gitignore",
    ".visible",
    "line\nname.txt",
  ]);
  expect(names.truncated).toBe(true);
  const all = await searchFiles(root, "content", "needle", true, signal());
  expect(all.matches.map((item) => item.path).sort()).toEqual([
    ".visible",
    "ignored.txt",
    "line\nname.txt",
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
  expect(long.matches[0]!.text!.length).toBe(limits.searchLineBytes);
  expect(long.truncated).toBe(true);
  await writeFile(join(root, "many.txt"), "needle\n".repeat(limits.searchMatches + 1));
  const many = await searchFiles(root, "content", "needle", false, signal());
  expect(many.matches.length).toBe(limits.searchMatches);
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
