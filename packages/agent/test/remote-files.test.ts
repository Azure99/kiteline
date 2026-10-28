import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { limits, type Reply, type SavedFile, type UploadedFile } from "@kiteline/shared/protocol";
import { fileDownloadPath } from "@kiteline/shared/protocol/client";
import { client } from "../../cli/src/client.js";
import { serverFixture } from "../../server/test/fixture.js";
import { Agent } from "../src/agent.js";
import { stateFiles } from "../src/config.js";
import { testConfig } from "./support/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const server = await serverFixture();
  cleanups.push(server.close);
  const root = await mkdtemp("/var/tmp/kiteline-remote-files-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const config = testConfig(join(root, "agent"), {
    limits: { transfersPerDevice: 1 },
  });
  await mkdir(config.runDir, { recursive: true });
  const binding = server.store.newBinding();
  const identity = { ...server.store.bind(binding.code, "Files test"), server: server.origin };
  const agent = new Agent(config, identity);
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(workspacePath);
  await agent.start();
  const online = () =>
    server.app.connections.devices().find((device) => device.id === identity.deviceId)?.status;
  await expect.poll(online).toBe("online");
  const credential = server.store.createCredential("Files", [identity.deviceId], null);
  const api = client({ server: server.origin, token: credential.token });
  const target = (path: string) => ({
    deviceId: identity.deviceId,
    workspaceId: workspace.id,
    path,
  });
  const put = (channelId: string, body: Buffer) =>
    api.request(
      `/api/channels/${channelId}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(body),
      },
      (response) => response.json() as Promise<Reply<SavedFile | UploadedFile>>,
    );
  const temporaryRecords = async () =>
    JSON.parse(await readFile(join(config.dataDir, stateFiles.temporaryFiles), "utf8"));
  return { api, config, workspacePath, target, put, temporaryRecords, online };
}

test.each([
  {
    name: "multiple blocks",
    path: "blocks.bin",
    body: Buffer.concat([Buffer.alloc(limits.dataChunkBytes, 0xa5), Buffer.from([0x5a])]),
  },
  { name: "an empty file", path: "empty.bin", body: Buffer.alloc(0) },
])("real file channels upload and download $name", async ({ path, body }) => {
  const f = await fixture();
  const ready = await f.api.fileChannel(f.target(path), "file.write", {
    purpose: "upload",
    size: body.length,
    createOnly: true,
  });
  expect(ready.meta).toMatchObject({
    size: body.length,
    filename: path,
    targetPath: path,
    contentType: "application/octet-stream",
  });
  await expect(f.put(ready.channelId, body)).resolves.toMatchObject({
    outcome: "succeeded",
    result: { path, size: body.length },
  });
  expect(await readFile(join(f.workspacePath, path))).toEqual(body);
  await expect.poll(f.temporaryRecords).toEqual([]);
  const downloaded = await f.api.request(fileDownloadPath(f.target(path)), {}, async (response) => {
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    return Buffer.from(await response.arrayBuffer());
  });
  expect(downloaded).toEqual(body);
  expect(f.online()).toBe("online");
});

test("real text reads provide the revision used by save and return the published bytes", async () => {
  const f = await fixture();
  const path = "note.txt";
  const original = Buffer.from("original\n");
  await writeFile(join(f.workspacePath, path), original);
  const read = await f.api.fileChannel(f.target(path), "file.read", { purpose: "text" });
  expect(read.meta).toMatchObject({
    size: original.length,
    contentType: "text/plain; charset=utf-8",
  });
  expect(read.meta.revision).toEqual(expect.any(String));
  await expect(
    f.api.request(`/api/channels/${read.channelId}/content`, {}, (response) => response.text()),
  ).resolves.toBe(original.toString());
  const body = Buffer.concat([Buffer.alloc(limits.dataChunkBytes, 0x61), Buffer.from("\n")]);
  const write = await f.api.fileChannel(f.target(path), "file.write", {
    purpose: "save",
    size: body.length,
    createOnly: false,
    expectedRevision: read.meta.revision!,
  });
  const reply = await f.put(write.channelId, body);
  expect(reply).toMatchObject({ outcome: "succeeded", result: { path, size: body.length } });
  expect(await readFile(join(f.workspacePath, path))).toEqual(body);
  await expect.poll(f.temporaryRecords).toEqual([]);
  const again = await f.api.fileChannel(f.target(path), "file.read", { purpose: "text" });
  expect(again.meta.revision).not.toBe(read.meta.revision);
  expect(reply.result).toMatchObject({ revision: again.meta.revision });
  await expect(
    f.api.request(`/api/channels/${again.channelId}/content`, {}, async (response) =>
      Buffer.from(await response.arrayBuffer()),
    ),
  ).resolves.toEqual(body);
});

test("real prepare errors and save result conflicts retain the file and the control connection", async () => {
  const f = await fixture();
  const path = "existing.txt";
  await writeFile(join(f.workspacePath, path), "original");
  await expect(
    f.api.fileChannel(f.target(path), "file.write", {
      purpose: "upload",
      size: 1,
      createOnly: true,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    f.api.fileChannel(f.target("large.txt"), "file.write", {
      purpose: "save",
      size: f.config.limits.editorBytes + 1,
      createOnly: true,
    }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(f.online()).toBe("online");
  expect(await readdir(f.workspacePath)).toEqual([path]);
  const read = await f.api.fileChannel(f.target(path), "file.read", { purpose: "text" });
  await f.api.request(`/api/channels/${read.channelId}/content`, {}, (response) => response.text());
  const replacement = Buffer.from("mine");
  const write = await f.api.fileChannel(f.target(path), "file.write", {
    purpose: "save",
    size: replacement.length,
    createOnly: false,
    expectedRevision: read.meta.revision!,
  });
  await writeFile(join(f.workspacePath, path), "external change");
  await expect(f.put(write.channelId, replacement)).resolves.toMatchObject({
    outcome: "failed",
    error: { code: "conflict" },
  });
  expect(await readFile(join(f.workspacePath, path), "utf8")).toBe("external change");
  await expect.poll(f.temporaryRecords).toEqual([]);
  expect(await readdir(f.workspacePath)).toEqual([path]);
  expect(f.online()).toBe("online");
});

test("cancelling a real reservation cleans disk state before another write is admitted", async () => {
  const f = await fixture();
  const body = Buffer.from("content");
  const ready = await f.api.fileChannel(f.target("cancelled"), "file.write", {
    purpose: "upload",
    size: body.length,
    createOnly: true,
  });
  expect(await f.temporaryRecords()).toHaveLength(1);
  expect(await readdir(f.workspacePath)).toHaveLength(1);
  await expect(
    f.api.fileChannel(f.target("busy"), "file.write", {
      purpose: "upload",
      size: body.length,
      createOnly: true,
    }),
  ).rejects.toMatchObject({ code: "busy" });
  await f.api.cancelChannel(ready.channelId);
  await expect.poll(f.temporaryRecords).toEqual([]);
  await expect.poll(() => readdir(f.workspacePath)).toEqual([]);
  const next = await f.api.fileChannel(f.target("next"), "file.write", {
    purpose: "upload",
    size: body.length,
    createOnly: true,
  });
  await expect(f.put(next.channelId, body)).resolves.toMatchObject({
    outcome: "succeeded",
  });
  expect(await readFile(join(f.workspacePath, "next"))).toEqual(body);
  await expect.poll(f.temporaryRecords).toEqual([]);
});
