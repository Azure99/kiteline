import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Directories } from "../src/directories.js";
import { Agent } from "../src/control.js";
import { MetadataStore } from "../src/metadata.js";
import { defaultAgentLimits, type AgentConfig } from "../src/config.js";

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
