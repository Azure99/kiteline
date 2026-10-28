import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkMetadata, limits, type Metadata } from "@kiteline/shared/protocol";
import { stateFiles } from "../src/config.js";
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

test("new device scrollback defaults to 5000 and saved settings keep their value", async () => {
  const dataDir = await directory();
  const metadata = new MetadataStore(config(dataDir), () => {});
  await metadata.load();
  expect(metadata.value.settings.historyLines).toBe(5_000);
  for (const historyLines of [0, 1_234, 10_000]) {
    await metadata.updateSettings(historyLines);
    const restored = new MetadataStore(config(dataDir), () => {});
    await restored.load();
    expect(restored.value.settings.historyLines).toBe(historyLines);
  }
});

test("duplicate workspace registration still saves a revision before publishing its notification", async () => {
  const dataDir = await directory();
  const project = join(dataDir, "project");
  await mkdir(project);
  await symlink(project, join(dataDir, "alias"));
  const path = join(dataDir, stateFiles.metadata);
  const notifications: Metadata[] = [];
  const metadata = new MetadataStore(config(dataDir), (snapshot) => {
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(snapshot);
    expect(metadata.value).toEqual(snapshot);
    notifications.push(snapshot);
  });
  await metadata.load();
  expect(notifications).toEqual([]);
  const workspace = await metadata.add(project);
  expect(await metadata.add(join(dataDir, "alias"))).toEqual(workspace);
  expect(notifications.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
  expect(metadata.value.revision).toBe(2);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(metadata.value);
  const restored = new MetadataStore(config(dataDir), () => {});
  await restored.load();
  expect(restored.value.workspaces).toEqual([workspace]);
});

test("an unreachable old workspace does not block a valid new registration", async () => {
  const dataDir = await directory();
  const old = join(dataDir, "old");
  const next = join(dataDir, "next");
  await mkdir(old);
  await mkdir(next);
  const metadata = new MetadataStore(config(dataDir), () => {});
  await metadata.load();
  await metadata.add(old);
  await rm(old, { recursive: true });
  await symlink("old", old);
  expect(await metadata.add(next)).toMatchObject({ path: next });
  await expect(metadata.add(old)).rejects.toMatchObject({ code: "ELOOP" });
});

test("environment counts towards hello before metadata is committed", async () => {
  const dataDir = await directory();
  const path = join(dataDir, stateFiles.metadata);
  const notifications: Metadata[] = [];
  const metadata = new MetadataStore(config(dataDir), (snapshot) => notifications.push(snapshot));
  const candidate = {
    ...structuredClone(metadata.value),
    revision: 1,
    shortcuts: Array.from({ length: 16 }, (_, index) => ({
      id: String(index),
      name: "x",
      command: "x",
    })),
  };
  const bare = { type: "hello", snapshot: candidate, editorBytes: metadata.hello().editorBytes };
  let remaining = limits.controlMessageBytes - Buffer.byteLength(JSON.stringify(bare)) - 1;
  for (const shortcut of candidate.shortcuts) {
    const size = Math.min(remaining, limits.shortcutCommandLength - shortcut.command.length);
    shortcut.command += "x".repeat(size);
    remaining -= size;
  }
  expect(remaining).toBe(0);
  expect(checkMetadata(candidate)).toEqual(candidate);
  expect(Buffer.byteLength(JSON.stringify(bare))).toBeLessThan(limits.controlMessageBytes);
  const overflow =
    Buffer.byteLength(JSON.stringify(metadata.hello(candidate))) - limits.controlMessageBytes;
  expect(overflow).toBeGreaterThan(0);
  const initial = structuredClone(candidate);
  initial.revision = 0;
  initial.shortcuts[0]!.command = initial.shortcuts[0]!.command.slice(overflow + 1);
  expect(checkMetadata(initial)).toEqual(initial);
  expect(Buffer.byteLength(JSON.stringify(metadata.hello(initial)))).toBeLessThan(
    limits.controlMessageBytes,
  );
  expect(
    Buffer.byteLength(JSON.stringify({ type: "metadata.snapshot", snapshot: initial })),
  ).toBeLessThan(limits.controlMessageBytes);
  await writeFile(path, JSON.stringify(initial) + "\n");
  await metadata.load();
  const before = await readFile(path, "utf8");
  expect(metadata.value).toEqual(initial);
  expect(notifications).toEqual([]);

  await expect(metadata.putShortcut(candidate.shortcuts[0]!)).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  expect(metadata.value).toEqual(initial);
  expect(await readFile(path, "utf8")).toBe(before);
  expect(notifications).toEqual([]);
});

test("a failed metadata rename preserves the published state and the next commit can succeed", async () => {
  const dataDir = await directory();
  const path = join(dataDir, stateFiles.metadata);
  const notifications: Metadata[] = [];
  const metadata = new MetadataStore(config(dataDir), (snapshot) => {
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(snapshot);
    expect(metadata.value).toEqual(snapshot);
    notifications.push(snapshot);
  });
  await metadata.load();
  const before = structuredClone(metadata.value);
  await mkdir(path);
  const marker = join(path, "retained");
  await writeFile(marker, "unchanged");

  await expect(metadata.updateSettings(1234)).rejects.toMatchObject({
    syscall: "rename",
    dest: path,
  });
  expect(metadata.value).toEqual(before);
  expect(notifications).toEqual([]);
  expect((await stat(path)).isDirectory()).toBe(true);
  expect(await readFile(marker, "utf8")).toBe("unchanged");

  await rm(path, { recursive: true });
  await expect(metadata.updateSettings(1234)).resolves.toEqual({ historyLines: 1234 });
  expect(metadata.value).toEqual({
    ...before,
    revision: before.revision + 1,
    settings: { historyLines: 1234 },
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(metadata.value);
  expect(notifications).toEqual([metadata.value]);
});

test("new device shortcuts do not replace saved customizations or restore deleted defaults", async () => {
  const dataDir = await directory();
  const metadata = new MetadataStore(config(dataDir), () => {});
  await metadata.load();
  expect(metadata.value.shortcuts.map(({ name, command }) => [name, command])).toEqual([
    ["Claude Code", "claude"],
    ["Codex", "codex"],
    ["OpenCode", "opencode"],
  ]);
  const defaults = metadata.value.shortcuts;
  const custom = await metadata.putShortcut({ name: "Project", command: "./project.sh" });
  for (const shortcut of defaults) await metadata.removeShortcut(shortcut.id);
  expect(metadata.value.shortcuts).toEqual([custom]);
  const restored = new MetadataStore(config(dataDir), () => {});
  await restored.load();
  expect(restored.value.shortcuts).toEqual(metadata.value.shortcuts);
  for (const shortcut of restored.value.shortcuts) await restored.removeShortcut(shortcut.id);
  const empty = new MetadataStore(config(dataDir), () => {});
  await empty.load();
  expect(empty.value.shortcuts).toEqual([]);
});
