import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Files } from "../src/files/index.js";
import { Directories } from "../src/files/directories.js";
import { MetadataStore } from "../src/metadata.js";
import { testConfig } from "./support/config.js";
import { publish } from "../src/files/publish.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const data = await mkdtemp("/var/tmp/kiteline-files-test-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const metadata = new MetadataStore(testConfig(data));
  const workspace = await metadata.add(root);
  const directories = new Directories();
  cleanups.push(() => directories.close());
  return {
    root,
    data,
    id: workspace.id,
    files: new Files(metadata, directories),
  };
}

test("Files preserves UTF-8 paths and browses accessible links outside its workspace", async () => {
  const { files, id, root, data } = await setup();
  const name = "  中文\nnotes.txt ";
  await files.create(id, name, "file");
  await writeFile(Buffer.concat([Buffer.from(root + "/"), Buffer.from([255])]), "raw");
  await mkdir(join(data, "external"));
  await writeFile(join(data, "external/visible"), "outside");
  await symlink("../external", join(root, "link"));
  const page = await files.list(id, ".");
  expect(page.entries.items.find((entry) => entry.name === name)?.path).toBe(name);
  expect(page.entries.items.find((entry) => entry.unavailableReason)?.path).toBeNull();
  const external = await files.list(id, "link");
  expect(external.resolvedPath).toBe(join(data, "external"));
  expect(external.entries.items[0]?.path).toBe("link/visible");
  await files.rename(id, "link/visible", "moved");
  expect(await readFile(join(data, "external/moved"), "utf8")).toBe("outside");
  expect(() => files.create(id, "../escape", "file")).toThrow(
    "A relative path within the workspace is required",
  );
});

test("concurrent exclusive publications never replace an existing name or dangling link", async () => {
  const { files, id, root } = await setup();
  await writeFile(join(root, "a"), "A");
  await writeFile(join(root, "b"), "B");
  const replies = await Promise.allSettled([
    files.rename(id, "a", "target"),
    files.rename(id, "b", "target"),
  ]);
  expect(replies.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(join(root, "target"), "utf8")).toBe("A");
  expect(await readFile(join(root, "b"), "utf8")).toBe("B");
  await symlink("missing", join(root, "dangling"));
  await expect(files.rename(id, "b", "dangling")).rejects.toMatchObject({ code: "EEXIST" });
  await expect(files.create(id, "dangling", "file")).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readlink(join(root, "dangling"))).toBe("missing");
});

test("root protection applies to the directory entry and copy names use actual directory contents", async () => {
  const { files, id, root } = await setup();
  await expect(files.rename(id, ".", "changed")).rejects.toMatchObject({
    code: "invalid_argument",
  });
  await symlink(root, join(root, "self"));
  await files.rename(id, "self", "alias");
  expect((await lstat(join(root, "alias"))).isSymbolicLink()).toBe(true);
  for (const name of ["config.json", "config (2).json", ".env"])
    await files.create(id, name, "file");
  expect((await files.inspect(id, "config.json", true)).suggestedName).toBe("config (3).json");
  expect((await files.inspect(id, ".env", true)).suggestedName).toBe(".env (2)");
  const before = (await files.inspect(id, "config.json")).targetVersion;
  await writeFile(join(root, "config.json"), "changed");
  expect((await files.inspect(id, "config.json")).targetVersion).not.toBe(before);
});

test("directory changes expire continuation and cancelled queued mutations do not execute", async () => {
  const { files, id, root } = await setup();
  for (let i = 0; i < 501; i++) await writeFile(join(root, `entry-${i}`), "");
  const first = await files.list(id, ".");
  expect(first.entries.items).toHaveLength(500);
  await writeFile(join(root, "new-entry"), "");
  await expect(files.list(id, ".", first.entries.nextCursor)).rejects.toMatchObject({
    code: "conflict",
  });
  const controller = new AbortController();
  let release!: () => void;
  const barrier = publish(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const creation = files.create(id, "cancelled", "file", controller.signal);
  controller.abort();
  release();
  await barrier;
  await expect(creation).rejects.toMatchObject({ name: "AbortError" });
  await expect(lstat(join(root, "cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("pagination budgets final relative paths through long links without losing entries", async () => {
  const { files, id, root, data } = await setup();
  const outside = join(data, "outside");
  await mkdir(outside);
  for (let i = 0; i < 500; i++) await writeFile(join(outside, `file-${i}`), "");
  const prefix = Array.from({ length: 12 }, (_, i) => `${i}-${"\u0001".repeat(197)}`).join("/");
  await mkdir(join(root, prefix), { recursive: true });
  const path = prefix + "/link";
  await symlink(outside, join(root, path));
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await files.list(id, path, cursor);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512 * 1024);
    for (const entry of page.entries.items) {
      expect(entry.path).toBe(`${path}/${entry.name}`);
      names.add(entry.name);
    }
    cursor = page.entries.nextCursor;
  } while (cursor);
  expect(names.size).toBe(500);
});
