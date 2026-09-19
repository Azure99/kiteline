import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  truncate,
  rename,
  symlink,
  lstat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { defaultAgentLimits } from "../src/config.js";
import { MetadataStore } from "../src/metadata.js";
import { TemporaryFiles } from "../src/files/temporary.js";
import { BinaryFiles } from "../src/files/binary.js";
import { locate, versionOf } from "../src/files/paths.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp("/var/tmp/kiteline-binary-");
  roots.push(home);
  const root = join(home, "project");
  await mkdir(root);
  const config = {
    dataDir: home,
    runDir: join(home, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits, editorBytes: 4 },
  };
  const metadata = new MetadataStore(config);
  const { id } = await metadata.add(root);
  const temporary = new TemporaryFiles(home);
  const files = new BinaryFiles(config, metadata, temporary);
  return { home, root, config, id, temporary, files, signal: new AbortController().signal };
}

test("binary upload is independent of text limits and replaces only the confirmed link entry", async () => {
  const { root, home, id, files, temporary, signal } = await setup();
  await writeFile(join(root, "shared"), "original");
  await symlink("shared", join(root, "config"));
  const where = await locate(root, "config");
  const version = versionOf(
    where.parent,
    where.name,
    await lstat(where.absolute, { bigint: true }),
  );
  await expect(files.prepare(id, "config", 300_000, true, undefined, signal)).rejects.toMatchObject(
    { code: "conflict" },
  );
  const bytes = Buffer.alloc(300_000, 0xff);
  const upload = await files.prepare(id, "config", bytes.length, false, version, signal);
  try {
    for (let i = 0; i < bytes.length; i += 65536)
      upload.received += await temporary.write(
        upload.temporary,
        bytes.subarray(i, i + 65536),
        upload.received,
        signal,
      );
    expect(await files.save(upload, signal)).toMatchObject({ path: "config", size: bytes.length });
  } finally {
    await temporary.release(upload.temporary, upload);
  }
  expect(await readFile(join(root, "config"))).toEqual(bytes);
  expect(await readFile(join(root, "shared"), "utf8")).toBe("original");
  expect(JSON.parse(await readFile(join(home, "temporary-files.json"), "utf8"))).toEqual([]);
  const competing = await files.prepare(id, "new", 3, true, undefined, signal);
  competing.received = await temporary.write(competing.temporary, Buffer.from("new"), 0, signal);
  await writeFile(join(root, "new"), "competitor");
  await expect(files.save(competing, signal)).rejects.toMatchObject({ code: "conflict" });
  await temporary.release(competing.temporary, competing);
  expect(await readFile(join(root, "new"), "utf8")).toBe("competitor");
});

test("download retains the initial handle and length while append, replace or late truncation is allowed", async () => {
  const { root, id, files, signal } = await setup();
  await writeFile(join(root, "log"), "abcdef");
  const reading = await files.read(id, "log", "download", signal);
  await appendFile(join(root, "log"), "new tail");
  await rename(join(root, "log"), join(root, "old"));
  await writeFile(join(root, "log"), "replacement");
  expect(reading.meta.size).toBe(6);
  expect((await reading.read(0, 2)).toString()).toBe("ab");
  expect((await reading.read(2, 4)).toString()).toBe("cdef");
  await truncate(join(root, "old"), 0);
  await reading.finish();
  const short = await files.read(id, "log", "download", signal);
  await truncate(join(root, "log"), 0);
  await expect(short.read(0, short.meta.size)).rejects.toMatchObject({ code: "io_error" });
  await short.close();
  const empty = await files.read(id, "log", "download", signal);
  expect(empty.meta.size).toBe(0);
  await empty.finish();
});

test("image metadata uses actual bytes and enforces pixel and final file checks", async () => {
  const { root, id, files, signal, config } = await setup();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(root, "image.wrong-extension"), png);
  const image = await files.read(id, "image.wrong-extension", "image", signal);
  expect(image.meta).toMatchObject({ contentType: "image/png", width: 1, height: 1 });
  expect(await image.read(0, png.length)).toEqual(png);
  await appendFile(join(root, "image.wrong-extension"), "changed");
  await expect(image.finish()).rejects.toMatchObject({ code: "conflict" });
  config.limits.imagePixels = 0;
  await expect(files.read(id, "image.wrong-extension", "image", signal)).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  await writeFile(join(root, "fake.png"), "<svg></svg>");
  await expect(files.read(id, "fake.png", "image", signal)).rejects.toMatchObject({
    code: "unsupported",
  });
});
