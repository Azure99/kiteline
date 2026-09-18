import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("native publish never overwrites an existing target", async () => {
  const directory = await mkdtemp("/var/tmp/kiteline-native-test-");
  directories.push(directory);
  const source = resolve(directory, "source");
  const target = resolve(directory, "target");
  const executable = resolve("dist/native/bin/rename-noreplace");
  await writeFile(source, "new");
  await writeFile(target, "old");
  const conflict = spawnSync(executable, [source, target], { encoding: "utf8" });
  expect(conflict.status).toBe(1);
  expect(conflict.stderr.trim()).toBe("17");
  expect(await readFile(target, "utf8")).toBe("old");
  expect(await readFile(source, "utf8")).toBe("new");
  await rm(target);
  expect(spawnSync(executable, [source, target]).status).toBe(0);
  expect(await readFile(target, "utf8")).toBe("new");
  expect(spawnSync(executable, [source, target], { encoding: "utf8" }).stderr.trim()).toBe("2");
});
