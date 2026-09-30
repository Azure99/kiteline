import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Directories } from "../src/directories.js";
import { Agent } from "../src/control.js";
import { MetadataStore } from "../src/metadata.js";
import { defaultAgentLimits, type AgentConfig } from "../src/config.js";
import { absolutePath, checkMetadata, limits, windowsName } from "@kiteline/shared/protocol";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const path = await mkdtemp("/var/tmp/kiteline-directory-test-");
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
function config(dataDir: string): AgentConfig {
  return {
    dataDir,
    runDir: join(dataDir, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits },
  };
}

test("device paths distinguish native absolute paths from Windows aliases", () => {
  for (const path of [
    "C:\\",
    "C:/Users/Project",
    "\\\\host.example\\share\\folder",
    "\\\\host\\C$\\folder",
  ])
    expect(absolutePath(path, "windows")).toBe(path);
  for (const path of [
    "/",
    "\\folder",
    "C:folder",
    "\\\\?\\C:\\x",
    "\\\\.\\pipe\\x",
    "C:\\a:b",
    "C:\\AUX.txt",
    "C:\\folder.\\x",
  ])
    expect(() => absolutePath(path, "windows")).toThrow();
  for (const name of ["a\\b", "a:b", "CON .txt", "CONOUT$", "a.", "a "])
    expect(() => windowsName(name)).toThrow();
  expect(absolutePath("/a:b/CON.txt/space ", "linux")).toBe("/a:b/CON.txt/space ");
});

test("directory pages keep raw names non-actionable and enforce the concurrent cursor limit", async () => {
  const path = await directory();
  for (let index = 0; index < 501; index++) await writeFile(join(path, `file-${index}`), "");
  await writeFile(Buffer.concat([Buffer.from(path + "/"), Buffer.from([255])]), "raw");
  const directories = new Directories();
  cleanups.push(() => directories.close());
  const first = await directories.list(path);
  const second = await directories.list(path, first.entries.nextCursor);
  const entries = [...first.entries.items, ...second.entries.items];
  expect(entries).toHaveLength(502);
  expect(entries.find((entry) => entry.unavailableReason)).toMatchObject({
    path: null,
    unavailableReason: "invalid_utf8",
  });
  expect(entries.find((entry) => entry.name === "file-0")).toMatchObject({
    path: join(path, "file-0"),
    size: 0,
    mtime: expect.any(String),
  });
  const peer = await directories.list(path);
  for (let index = 0; index < 20; index++) {
    const page = await directories.list(path);
    await directories.release(page.entries.nextCursor!);
    await directories.release(page.entries.nextCursor!);
  }
  const peerMore = await directories.list(path, peer.entries.nextCursor);
  expect(peer.entries.items.length + peerMore.entries.items.length).toBe(502);
  const concurrent = await Promise.allSettled(
    Array.from({ length: 32 }, () => directories.list(path)),
  );
  expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(16);
  const saved = concurrent.find((result) => result.status === "fulfilled");
  expect(saved?.status).toBe("fulfilled");
  await directories.close();
  if (saved?.status === "fulfilled")
    await expect(directories.list(path, saved.value.entries.nextCursor)).rejects.toMatchObject({
      code: "conflict",
    });
});

test("closing a first directory read waits for it and prevents a late live cursor", async () => {
  const path = await directory();
  const directories = new Directories();
  cleanups.push(() => directories.close());
  const pending = directories.list(path);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await Promise.all([directories.close(), directories.close()]);
  await cancelled;
  await expect(directories.list(path)).resolves.toMatchObject({
    entries: { items: [], truncated: false },
  });
});

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

test("agent shutdown waits for an accepted workspace publication", async () => {
  const dataDir = await directory();
  const agent = new Agent(config(dataDir), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  const operation = agent.dispatch(
    "workspaces.add",
    { absolutePath: dataDir },
    new AbortController().signal,
  );
  await agent.close();
  await expect(operation).resolves.toMatchObject({ path: dataDir });
  const value = JSON.parse(await readFile(join(dataDir, "agent.json"), "utf8")) as {
    workspaces: { path: string }[];
  };
  expect(value.workspaces[0]?.path).toBe(dataDir);
  await expect(
    agent.dispatch("workspaces.add", { absolutePath: dataDir }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "cancelled" });
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

test("shortcut icons round-trip through RPC and metadata, and omitting one clears the old value", async () => {
  const dataDir = await directory();
  const agent = new Agent(config(dataDir), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  cleanups.push(() => agent.close());
  const signal = new AbortController().signal;
  await agent.dispatch(
    "shortcuts.put",
    { id: "claude", name: "Custom", command: "echo custom", icon: "rocket" },
    signal,
  );
  const read = async () =>
    checkMetadata(JSON.parse(await readFile(join(dataDir, "agent.json"), "utf8")));
  expect((await read()).shortcuts[0]).toMatchObject({
    name: "Custom",
    command: "echo custom",
    icon: "rocket",
  });
  await expect(
    agent.dispatch(
      "shortcuts.put",
      { id: "claude", name: "Custom", command: "echo custom", icon: "other" },
      signal,
    ),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  const result = await agent.dispatch(
    "shortcuts.put",
    { id: "claude", name: "Custom", command: "echo custom" },
    signal,
  );
  expect(result).not.toHaveProperty("icon", "rocket");
  expect((await read()).shortcuts[0]).toEqual({
    id: "claude",
    name: "Custom",
    command: "echo custom",
  });
  expect(agent.metadata.hello().snapshot.shortcuts[0]?.icon).toBeUndefined();
});
