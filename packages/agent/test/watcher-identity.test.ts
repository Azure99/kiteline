import { afterEach, expect, test } from "vitest";
import { watch } from "chokidar";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp("/var/tmp/kiteline-watcher-identity-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  async function subscribe(path: string) {
    const events: { event: string; path: string }[] = [];
    // Observe reattachment before releasing the tree owner, without unlink/add coalescing.
    const watcher = watch(path, { ignoreInitial: true, followSymlinks: false, atomic: false });
    cleanups.push(() => watcher.close());
    watcher.on("all", (event, path) => events.push({ event, path }));
    await once(watcher, "ready");
    events.length = 0;
    return { watcher, events };
  }
  return { root, subscribe };
}

test.runIf(process.platform === "linux")(
  "replacing an ancestor rebinds shared file handles for remaining owners",
  async () => {
    const { root, subscribe } = await setup();
    const project = join(root, "project"),
      child = join(project, "child"),
      replacement = join(root, "replacement");
    await mkdir(child, { recursive: true });
    await mkdir(replacement);
    const file = join(child, "file");
    await writeFile(file, "old");
    await writeFile(join(replacement, "file"), "new");
    const tree = await subscribe(project);
    const leaf = await subscribe(file);
    await rename(child, join(root, "old"));
    await rename(replacement, child);
    await expect
      .poll(() => tree.events.some((entry) => entry.event === "add" && entry.path === file), {
        timeout: 5000,
      })
      .toBe(true);
    await tree.watcher.close();
    leaf.events.length = 0;
    await appendFile(file, "remaining owner");
    await expect
      .poll(() => leaf.events.some((entry) => entry.path === file), { timeout: 5000 })
      .toBe(true);
  },
);

test.runIf(process.platform === "linux")(
  "a symlink watch does not replace the identity of its shared parent",
  async () => {
    const { root, subscribe } = await setup();
    const project = join(root, "project"),
      outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    const link = join(project, "link");
    await symlink(outside, link);
    const tree = await subscribe(project);
    const linked = await subscribe(link);
    await writeFile(join(outside, "ignored"), "outside tree");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tree.events).toEqual([]);
    expect(linked.events).toEqual([]);
    await linked.watcher.close();
    const file = join(project, "visible");
    await writeFile(file, "parent still watched");
    await expect
      .poll(() => tree.events.some((entry) => entry.path === file), { timeout: 5000 })
      .toBe(true);
  },
);

test.runIf(process.platform === "linux")(
  "successive directory replacements keep same-named descendants watched",
  async () => {
    const { root, subscribe } = await setup();
    const project = join(root, "project"),
      child = join(project, "child"),
      file = join(child, "deep/file");
    for (const path of [child, join(root, "first"), join(root, "second")]) {
      await mkdir(join(path, "deep"), { recursive: true });
      await writeFile(join(path, "deep/file"), "content");
    }
    const tree = await subscribe(project);
    await rename(child, join(root, "old-first"));
    await rename(join(root, "first"), child);
    await expect
      .poll(() => tree.events.some((entry) => entry.event === "add" && entry.path === file), {
        timeout: 5000,
        interval: 2,
      })
      .toBe(true);
    tree.events.length = 0;
    await rename(child, join(root, "old-second"));
    await rename(join(root, "second"), child);
    await expect
      .poll(() => tree.events.some((entry) => entry.event === "add" && entry.path === file), {
        timeout: 5000,
        interval: 2,
      })
      .toBe(true);
    tree.events.length = 0;
    await appendFile(file, "after second replacement");
    await expect
      .poll(() => tree.events.some((entry) => entry.path === file), { timeout: 5000 })
      .toBe(true);
  },
);
