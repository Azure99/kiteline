import { expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { TemporaryFiles } from "../src/files/temporary.js";
import { installationFile, readInstallation } from "../src/installation.js";

test("invalid temporary records preserve the whole registry and valid pending files", async () => {
  const root = await fs.mkdtemp("/var/tmp/kiteline-temporary-records-");
  const owner = new TemporaryFiles(root);
  try {
    const signal = new AbortController().signal;
    await owner.load();
    const pending = await owner.create(root, await fs.stat(root, { bigint: true }), signal);
    await owner.write(pending, Buffer.from("pending"), 0, signal);
    await owner.closeFile(pending);
    await owner.close();
    const path = join(root, "temporary-files.json");
    const valid = await fs.readFile(path, "utf8");
    for (const content of [JSON.stringify([...JSON.parse(valid), {}]), "", "null"]) {
      await fs.writeFile(path, content);
      const restored = new TemporaryFiles(root);
      try {
        await expect(restored.load()).rejects.toThrow(path);
      } finally {
        await restored.close();
      }
      expect(await fs.readFile(path, "utf8")).toBe(content);
      expect(await fs.readFile(pending.path, "utf8")).toBe("pending");
    }
    await fs.writeFile(path, valid);
    const restored = new TemporaryFiles(root);
    try {
      await restored.load();
      await restored.drain();
      await expect(fs.readFile(pending.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual([]);
    } finally {
      await restored.close();
    }
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installation records distinguish a missing file from damaged current data", async () => {
  const root = await fs.mkdtemp("/var/tmp/kiteline-installation-record-");
  const path = join(root, "installation.json");
  const read = fs.readFile;
  const reader = vi
    .spyOn(fs, "readFile")
    .mockImplementation(((file, options) =>
      read(file === installationFile ? path : file, options)) as typeof fs.readFile);
  syncBuiltinESMExports();
  try {
    expect(await readInstallation()).toBeUndefined();
    const value = { user: "kiteline", uid: 1000, gid: 1000, home: "/home/kiteline" };
    await fs.writeFile(path, JSON.stringify(value));
    expect(await readInstallation()).toEqual(value);
    for (const content of [
      "",
      "{",
      "null",
      "false",
      "0",
      "{}",
      JSON.stringify({ ...value, home: "relative" }),
    ]) {
      await fs.writeFile(path, content);
      await expect(readInstallation()).rejects.toThrow(installationFile);
      expect(await fs.readFile(path, "utf8")).toBe(content);
    }
  } finally {
    reader.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
