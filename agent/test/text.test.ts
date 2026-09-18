import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  symlink,
  readlink,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../src/metadata.js";
import { defaultAgentLimits } from "../src/config.js";
import { TextFiles } from "../src/files/text.js";
import { TemporaryFiles } from "../src/files/temporary.js";
import { decodeText, encodeText } from "@kiteline/shared/text";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const data = await mkdtemp("/var/tmp/kiteline-text-test-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const config = {
    dataDir: data,
    runDir: join(data, "run"),
    shell: "/bin/sh",
    limits: { ...defaultAgentLimits },
  };
  const metadata = new MetadataStore(config);
  const workspace = await metadata.add(root);
  const files = new TextFiles(config, metadata);
  const signal = new AbortController().signal;
  return { root, data, id: workspace.id, files, signal, config };
}

test("text revisions survive same-byte inode replacement and save follows links atomically", async () => {
  const { files, id, root, signal } = await setup();
  const original = Buffer.from("\uFEFFa\r\n中\r\n");
  await writeFile(join(root, "target"), original, { mode: 0o640 });
  await symlink("target", join(root, "link"));
  const first = await files.read(id, "link", signal);
  expect(first.meta).toMatchObject({
    bom: true,
    lineEnding: "crlf",
    mode: 0o640,
    resolvedPath: join(root, "target"),
  });
  const { text, format } = decodeText(first.bytes);
  expect(Buffer.from(encodeText(text, format))).toEqual(original);
  await first.finish();
  await writeFile(join(root, "replacement"), original, { mode: 0o640 });
  await rename(join(root, "replacement"), join(root, "target"));
  const current = await files.read(id, "link", signal);
  expect(current.meta.revision).toBe(first.meta.revision);
  await current.finish();
  const bytes = Buffer.from(encodeText("edited\n", format));
  const write = await files.prepare(id, "link", bytes.length, false, first.meta.revision, signal);
  await files.write(write, bytes, signal);
  const saved = await files.save(write, signal);
  await files.cleanup(write);
  expect(await readlink(join(root, "link"))).toBe("target");
  expect(await readFile(join(root, "target"))).toEqual(bytes);
  expect((await stat(join(root, "target"))).mode & 0o777).toBe(0o640);
  const after = await files.read(id, "link", signal);
  expect(after.meta.revision).toBe(saved.revision);
  await after.finish();
});

test("late saves conflict after content changes or rename and never recreate the old target", async () => {
  const { files, id, root, signal, data } = await setup();
  await writeFile(join(root, "a"), "old");
  const before = await files.read(id, "a", signal);
  await before.finish();
  const write = await files.prepare(id, "a", 3, false, before.meta.revision, signal);
  await files.write(write, Buffer.from("new"), signal);
  await writeFile(join(root, "a"), "external");
  await expect(files.save(write, signal)).rejects.toMatchObject({ code: "conflict" });
  await files.cleanup(write);
  expect(await readFile(join(root, "a"), "utf8")).toBe("external");
  const next = await files.prepare(id, "a", 3, false, before.meta.revision, signal);
  await files.write(next, Buffer.from("new"), signal);
  await rename(join(root, "a"), join(root, "renamed"));
  await expect(files.save(next, signal)).rejects.toMatchObject({ code: "conflict" });
  await files.cleanup(next);
  await expect(stat(join(root, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(data, "temporary-files.json"), "utf8"))).toEqual([]);
});

test("read completion detects changed content, rejects non-text and enforces encoded capacity", async () => {
  const { files, id, root, signal, config } = await setup();
  await writeFile(join(root, "a"), "first");
  const read = await files.read(id, "a", signal);
  await writeFile(join(root, "a"), "later content");
  await expect(read.finish()).rejects.toMatchObject({ code: "conflict" });
  await writeFile(join(root, "binary"), Buffer.from([1, 0, 3]));
  await expect(files.read(id, "binary", signal)).rejects.toMatchObject({ code: "unsupported" });
  await writeFile(join(root, "invalid"), Buffer.from([0xff]));
  await expect(files.read(id, "invalid", signal)).rejects.toMatchObject({ code: "unsupported" });
  await writeFile(join(root, "mixed"), "a\r\nb\r\nc\n");
  config.limits.editorBytes = 8;
  await expect(files.read(id, "mixed", signal)).rejects.toMatchObject({ code: "limit_exceeded" });
  await writeFile(join(root, "empty"), "");
  const empty = await files.read(id, "empty", signal);
  await empty.finish();
  expect(empty.meta.size).toBe(0);
});

test("startup cleans only the registered temporary identity and exclusive saves reject races", async () => {
  const { files, id, root, data, signal } = await setup();
  const pending = await files.prepare(id, "new", 3, true, undefined, signal);
  await files.write(pending, Buffer.from("new"), signal);
  await files.temporary.closeFile(pending.temporary);
  await writeFile(join(root, ".kiteline-unregistered.tmp"), "keep");
  const restored = new TemporaryFiles(data);
  await restored.cleanStartup();
  await expect(stat(pending.temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, ".kiteline-unregistered.tmp"), "utf8")).toBe("keep");
  const race = await files.prepare(id, "new", 3, true, undefined, signal);
  await files.write(race, Buffer.from("new"), signal);
  await symlink("missing", join(root, "new"));
  await expect(files.save(race, signal)).rejects.toMatchObject({ code: "EEXIST" });
  await files.cleanup(race);
  expect(await readlink(join(root, "new"))).toBe("missing");
});

test("lowering the editor limit still allows saving a reduced draft against its original version", async () => {
  const { files, id, root, config, signal } = await setup();
  await writeFile(join(root, "a"), "long baseline");
  const before = await files.read(id, "a", signal);
  await before.finish();
  config.limits.editorBytes = 4;
  const write = await files.prepare(id, "a", 3, false, before.meta.revision, signal);
  await files.write(write, Buffer.from("new"), signal);
  await files.save(write, signal);
  await files.cleanup(write);
  expect(await readFile(join(root, "a"), "utf8")).toBe("new");
});
