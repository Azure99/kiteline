import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { checkMetadata, limits } from "@kiteline/shared/protocol";
import { MetadataStore } from "../src/metadata.js";
import { testConfig as config } from "./support/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const path = await mkdtemp("/var/tmp/kiteline-metadata-test-");
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("workspace registration deduplicates canonical paths and failed budgets do not publish", async () => {
  const dataDir = await directory();
  const project = join(dataDir, "project");
  await mkdir(project);
  await symlink(project, join(dataDir, "alias"));
  const metadata = new MetadataStore(config(dataDir));
  await metadata.load();
  const workspace = await metadata.add(project);
  expect(await metadata.add(join(dataDir, "alias"))).toEqual(workspace);
  const before = await readFile(join(dataDir, "agent.json"), "utf8");
  const revision = metadata.value.revision;
  await expect(
    metadata.update((candidate) => {
      candidate.shortcuts = Array.from({ length: 20 }, (_, id) => ({
        id: String(id),
        name: String(id),
        command: "x".repeat(65_536),
      }));
    }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(metadata.value.revision).toBe(revision);
  expect(await readFile(join(dataDir, "agent.json"), "utf8")).toBe(before);
  const restored = new MetadataStore(config(dataDir));
  await restored.load();
  expect(restored.value.workspaces).toEqual([workspace]);
});

test("an unreachable old workspace does not block a valid new registration", async () => {
  const dataDir = await directory();
  const old = join(dataDir, "old");
  const next = join(dataDir, "next");
  await mkdir(old);
  await mkdir(next);
  const metadata = new MetadataStore(config(dataDir));
  await metadata.add(old);
  await rm(old, { recursive: true });
  await symlink("old", old);
  expect(await metadata.add(next)).toMatchObject({ path: next });
  await expect(metadata.add(old)).rejects.toMatchObject({ code: "ELOOP" });
});

test("environment counts towards hello before metadata is committed", async () => {
  const dataDir = await directory();
  const metadata = new MetadataStore(config(dataDir));
  await metadata.add(dataDir);
  const before = await readFile(join(dataDir, "agent.json"), "utf8");
  const candidate = structuredClone(metadata.value);
  candidate.shortcuts = Array.from({ length: 16 }, (_, index) => ({
    id: String(index),
    name: "x",
    command: "x",
  }));
  const bare = { type: "hello", snapshot: candidate, editorBytes: metadata.hello().editorBytes };
  let remaining = limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(bare)) - 1;
  for (const shortcut of candidate.shortcuts) {
    const size = Math.min(remaining, 65_535);
    shortcut.command += "x".repeat(size);
    remaining -= size;
  }
  expect(remaining).toBe(0);
  expect(checkMetadata(candidate)).toEqual(candidate);
  expect(Buffer.byteLength(JSON.stringify(bare))).toBeLessThan(limits.controlMessageBytes);
  await expect(
    metadata.update((value) => {
      value.shortcuts = candidate.shortcuts;
    }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(await readFile(join(dataDir, "agent.json"), "utf8")).toBe(before);
});

test("new device shortcuts do not replace saved customizations or restore deleted defaults", async () => {
  const dataDir = await directory();
  const metadata = new MetadataStore(config(dataDir));
  await metadata.load();
  expect(metadata.value.shortcuts.map(({ name, command }) => [name, command])).toEqual([
    ["Claude Code", "claude"],
    ["Codex", "codex"],
    ["OpenCode", "opencode"],
  ]);
  await metadata.update((value) => {
    value.shortcuts = [{ id: "custom", name: "Project", command: "./project.sh" }];
  });
  const restored = new MetadataStore(config(dataDir));
  await restored.load();
  expect(restored.value.shortcuts).toEqual(metadata.value.shortcuts);
  await restored.update((value) => {
    value.shortcuts = [];
  });
  const empty = new MetadataStore(config(dataDir));
  await empty.load();
  expect(empty.value.shortcuts).toEqual([]);
});
