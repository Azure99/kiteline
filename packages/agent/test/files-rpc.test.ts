import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import { testConfig } from "./support/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const data = await mkdtemp("/var/tmp/kiteline-files-rpc-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const agent = new Agent(testConfig(data), {
    deviceId: "test",
    deviceToken: "test",
    server: "https://localhost",
  });
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(root);
  return { root, agent, id: workspace.id };
}

test.each([
  { kind: "high", json: '"\\ud800"' },
  { kind: "low", json: '"\\udc00"' },
])("unpaired $kind surrogates cannot create, rename, or delete another entry", async ({ json }) => {
  const { root, agent, id } = await setup();
  const name: string = JSON.parse(json);
  const signal = new AbortController().signal;
  await expect(
    agent.dispatch("files.create", { workspaceId: id, path: name, kind: "file" }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(await readdir(root)).toEqual([]);

  await writeFile(join(root, "source"), "source contents");
  await expect(
    agent.dispatch("files.rename", { workspaceId: id, path: "source", newName: name }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(await readFile(join(root, "source"), "utf8")).toBe("source contents");
  expect(existsSync(join(root, "\uFFFD"))).toBe(false);

  await expect(
    agent.dispatch("directories.mkdir", { absolutePath: join(root, name) }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(existsSync(join(root, "\uFFFD"))).toBe(false);

  await writeFile(join(root, "\uFFFD"), "valid replacement-character name");
  await expect(
    agent.dispatch("files.delete", { workspaceId: id, paths: [name] }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(await readFile(join(root, "\uFFFD"), "utf8")).toBe("valid replacement-character name");

  const parent = "nested-\uFFFD";
  await mkdir(join(root, parent));
  await writeFile(join(root, parent, "keep"), "nested contents");
  await expect(
    agent.dispatch(
      "files.create",
      { workspaceId: id, path: `nested-${name}/new`, kind: "file" },
      signal,
    ),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(await readdir(join(root, parent))).toEqual(["keep"]);
  expect(await readFile(join(root, parent, "keep"), "utf8")).toBe("nested contents");
});

test.each([
  { kind: "high", json: '"\\ud800"' },
  { kind: "low", json: '"\\udc00"' },
])("device path RPCs reject unpaired $kind surrogates in parent directories", async ({ json }) => {
  const { root, agent } = await setup();
  const parent = join(root, "nested-\uFFFD");
  await mkdir(parent);
  await writeFile(join(parent, "keep"), "nested contents");
  const invalidParent = join(root, `nested-${JSON.parse(json)}`);
  const metadata = structuredClone(agent.metadata.value);
  const signal = new AbortController().signal;

  await expect(
    agent.dispatch("directories.mkdir", { absolutePath: join(invalidParent, "new") }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(
    agent.dispatch("directories.list", { absolutePath: invalidParent }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(
    agent.dispatch("workspaces.add", { absolutePath: invalidParent }, signal),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  expect(agent.metadata.value).toEqual(metadata);
  expect(await readdir(root)).toEqual(["nested-\uFFFD"]);
  expect(await readdir(parent)).toEqual(["keep"]);
  expect(await readFile(join(parent, "keep"), "utf8")).toBe("nested contents");
});

test.each(["\uFFFD", "😀"])("file and directory RPCs preserve the legal name %s", async (name) => {
  const { root, agent, id } = await setup();
  const signal = new AbortController().signal;
  const source = `source-${name}`;
  expect(
    await agent.dispatch("files.create", { workspaceId: id, path: source, kind: "file" }, signal),
  ).toMatchObject({ name: source, path: source });
  await writeFile(join(root, source), "legal Unicode contents");
  expect(
    await agent.dispatch("files.rename", { workspaceId: id, path: source, newName: name }, signal),
  ).toEqual({ from: source, to: name });
  expect(
    await agent.dispatch("files.inspect", { workspaceId: id, path: name }, signal),
  ).toMatchObject({
    entry: { name, path: name },
  });
  expect(await agent.dispatch("files.list", { workspaceId: id, path: "." }, signal)).toMatchObject({
    entries: { items: [expect.objectContaining({ name, path: name })] },
  });
  expect(await readFile(join(root, name), "utf8")).toBe("legal Unicode contents");
  await agent.dispatch("files.delete", { workspaceId: id, paths: [name] }, signal);
  expect(await readdir(root)).toEqual([]);

  const absolutePath = join(root, `directory-${name}`);
  expect(await agent.dispatch("directories.mkdir", { absolutePath }, signal)).toEqual({
    path: absolutePath,
  });
  expect(await readdir(root)).toEqual([`directory-${name}`]);
});
