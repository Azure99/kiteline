import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  symlink,
  readlink,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { MetadataStore } from "../src/metadata.js";
import { testConfig } from "./support/config.js";
import { TextFiles } from "../src/files/text.js";
import { readWorkspaceFile } from "../src/files/read.js";
import { TemporaryFiles } from "../src/files/temporary.js";
import { decodeText, encodeText } from "@kiteline/shared/protocol/text";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const data = await mkdtemp("/var/tmp/kiteline-text-test-");
  cleanups.push(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace");
  await mkdir(root);
  const config = testConfig(data);
  const metadata = new MetadataStore(config);
  const workspace = await metadata.add(root);
  const temporary = new TemporaryFiles(data);
  cleanups.push(() => temporary.close());
  const files = new TextFiles(config, metadata, temporary);
  const signal = new AbortController().signal;
  return { root, data, id: workspace.id, files, temporary, signal, config };
}

test("text revisions survive same-byte inode replacement and save follows links atomically", async () => {
  const { files, temporary, id, root, signal, config } = await setup();
  const original = Buffer.from("\uFEFFa\r\n中\r\n");
  await writeFile(join(root, "target"), original, { mode: 0o640 });
  await symlink("target", join(root, "link"));
  const first = await readWorkspaceFile(root, "link", "text", config.limits, signal);
  expect(first.meta).toMatchObject({
    bom: true,
    lineEnding: "crlf",
    mode: 0o640,
    resolvedPath: join(root, "target"),
  });
  const { text, format } = decodeText(await first.read(0, first.meta.size));
  expect(Buffer.from(encodeText(text, format))).toEqual(original);
  await first.finish();
  await writeFile(join(root, "replacement"), original, { mode: 0o640 });
  await rename(join(root, "replacement"), join(root, "target"));
  const current = await readWorkspaceFile(root, "link", "text", config.limits, signal);
  expect(current.meta.revision).toBe(first.meta.revision);
  await current.finish();
  const bytes = Buffer.from(encodeText("edited\n", format));
  const write = await files.prepare(id, "link", bytes.length, false, first.meta.revision, signal);
  write.received = await temporary.write(write.temporary, bytes, 0, signal);
  const saved = await files.save(write, signal);
  await temporary.release(write.temporary, write);
  expect(await readlink(join(root, "link"))).toBe("target");
  expect(await readFile(join(root, "target"))).toEqual(bytes);
  expect((await stat(join(root, "target"))).mode & 0o777).toBe(0o640);
  const after = await readWorkspaceFile(root, "link", "text", config.limits, signal);
  expect(after.meta.revision).toBe(saved.revision);
  await after.finish();
});

test("late saves conflict after content changes or rename and never recreate the old target", async () => {
  const { files, temporary, id, root, signal, config } = await setup();
  await writeFile(join(root, "a"), "old");
  const before = await readWorkspaceFile(root, "a", "text", config.limits, signal);
  await before.finish();
  const write = await files.prepare(id, "a", 3, false, before.meta.revision, signal);
  write.received = await temporary.write(write.temporary, Buffer.from("new"), 0, signal);
  await writeFile(join(root, "a"), "external");
  await expect(files.save(write, signal)).rejects.toMatchObject({ code: "conflict" });
  await temporary.release(write.temporary, write);
  expect(await readFile(join(root, "a"), "utf8")).toBe("external");
  const next = await files.prepare(id, "a", 3, false, before.meta.revision, signal);
  next.received = await temporary.write(next.temporary, Buffer.from("new"), 0, signal);
  await rename(join(root, "a"), join(root, "renamed"));
  await expect(files.save(next, signal)).rejects.toMatchObject({ code: "conflict" });
  await temporary.release(next.temporary, next);
  await expect(stat(join(root, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(root)).filter((name) => name.startsWith(".kiteline-"))).toEqual([]);
});

test("buffered text survives later disk changes, rejects non-text and enforces encoded capacity", async () => {
  const { root, signal, config } = await setup();
  await writeFile(join(root, "a"), "first");
  const read = await readWorkspaceFile(root, "a", "text", config.limits, signal);
  await writeFile(join(root, "a"), "later content");
  expect((await read.read(0, read.meta.size)).toString()).toBe("first");
  await read.finish();
  await writeFile(join(root, "binary"), Buffer.from([1, 0, 3]));
  await expect(
    readWorkspaceFile(root, "binary", "text", config.limits, signal),
  ).rejects.toMatchObject({ code: "unsupported" });
  await writeFile(join(root, "invalid"), Buffer.from([0xff]));
  await expect(
    readWorkspaceFile(root, "invalid", "text", config.limits, signal),
  ).rejects.toMatchObject({ code: "unsupported" });
  await writeFile(join(root, "mixed"), "a\r\nb\r\nc\n");
  config.limits.editorBytes = 8;
  await expect(
    readWorkspaceFile(root, "mixed", "text", config.limits, signal),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  await writeFile(join(root, "empty"), "");
  const empty = await readWorkspaceFile(root, "empty", "text", config.limits, signal);
  await empty.finish();
  expect(empty.meta.size).toBe(0);
});

test("automatic open uses content and independent limits while preserving text semantics", async () => {
  const { root, signal, config } = await setup();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  config.limits.editorBytes = 32;
  await writeFile(join(root, "extensionless"), png);
  const image = await readWorkspaceFile(root, "extensionless", "open", config.limits, signal);
  expect(image.meta).toMatchObject({ contentType: "image/png", width: 1, height: 1 });
  expect(await image.read(0, image.meta.size)).toEqual(png);
  await image.finish();
  await expect(
    readWorkspaceFile(root, "extensionless", "text", config.limits, signal),
  ).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  await writeFile(join(root, "text.png"), "\uFEFFtext\r\n");
  const text = await readWorkspaceFile(root, "text.png", "open", config.limits, signal);
  expect(text.meta).toMatchObject({
    contentType: "text/plain; charset=utf-8",
    bom: true,
    lineEnding: "crlf",
  });
  expect(text.meta.revision).toBeTruthy();
  await writeFile(join(root, "text.png"), "changed");
  expect((await text.read(0, text.meta.size)).toString()).toBe("\uFEFFtext\r\n");
  await text.finish();
  await writeFile(join(root, "large"), "x".repeat(33));
  await expect(
    readWorkspaceFile(root, "large", "open", config.limits, signal),
  ).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  config.limits.imagePixels = 0;
  await expect(
    readWorkspaceFile(root, "extensionless", "open", config.limits, signal),
  ).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  await writeFile(join(root, "broken"), png.subarray(0, 12));
  await expect(
    readWorkspaceFile(root, "broken", "open", config.limits, signal),
  ).rejects.toMatchObject({
    code: "unsupported",
  });
});

test("startup cleans registered temporary paths and exclusive saves reject occupied targets", async () => {
  const { files, temporary, id, root, data, signal } = await setup();
  const pending = await files.prepare(id, "new", 3, true, undefined, signal);
  pending.received = await temporary.write(pending.temporary, Buffer.from("new"), 0, signal);
  await temporary.closeFile(pending.temporary);
  await writeFile(join(root, ".kiteline-unregistered.tmp"), "keep");
  const restored = new TemporaryFiles(data);
  await restored.load();
  await restored.close();
  await expect(stat(pending.temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, ".kiteline-unregistered.tmp"), "utf8")).toBe("keep");
  const race = await files.prepare(id, "new", 3, true, undefined, signal);
  race.received = await temporary.write(race.temporary, Buffer.from("new"), 0, signal);
  await symlink("missing", join(root, "new"));
  await expect(files.save(race, signal)).rejects.toMatchObject({ code: "EEXIST" });
  await temporary.release(race.temporary, race);
  expect(await readlink(join(root, "new"))).toBe("missing");
});

test("lowering the editor limit still allows saving a reduced draft against its original version", async () => {
  const { files, temporary, id, root, config, signal } = await setup();
  await writeFile(join(root, "a"), "long baseline");
  const before = await readWorkspaceFile(root, "a", "text", config.limits, signal);
  await before.finish();
  config.limits.editorBytes = 4;
  const write = await files.prepare(id, "a", 3, false, before.meta.revision, signal);
  write.received = await temporary.write(write.temporary, Buffer.from("new"), 0, signal);
  await files.save(write, signal);
  await temporary.release(write.temporary, write);
  expect(await readFile(join(root, "a"), "utf8")).toBe("new");
});

test("cancelled temporary writers are cleaned after their real writes finish", async () => {
  const { files, temporary, id, signal } = await setup();
  const cancelled = await files.prepare(id, "cancelled", 6, true, undefined, signal);
  cancelled.received = await temporary.write(cancelled.temporary, Buffer.from("one"), 0, signal);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    temporary.write(cancelled.temporary, Buffer.from("two"), cancelled.received, controller.signal),
  ).rejects.toThrow("cancelled");
  await temporary.release(cancelled.temporary, cancelled);
  await expect(stat(cancelled.temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
});
