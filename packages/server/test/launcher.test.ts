import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const script = await readFile(
  new URL("../../../installer/kiteline-server", import.meta.url),
  "utf8",
);
const directories: string[] = [];
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-server-launcher-");
  directories.push(root);
  return root;
}

test("server launcher preserves paths and arguments through direct and relative link entries", async () => {
  const root = await directory();
  const source = join(root, "package with spaces, 'quotes' and $dollars");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "runtime/bin"), { recursive: true });
  await mkdir(join(source, "server/dist"), { recursive: true });
  await symlink(process.execPath, join(source, "runtime/bin/node"));
  await writeFile(
    join(source, "server/dist/main.js"),
    "console.log(JSON.stringify(process.argv.slice(2)));",
  );
  const launcher = join(source, "bin/kiteline-server");
  await writeFile(launcher, script, { mode: 0o755 });
  await symlink(
    "package with spaces, 'quotes' and $dollars/bin/kiteline-server",
    join(root, "first"),
  );
  await symlink("first", join(root, "second"));
  const args = ["argument with 'quotes' and $dollars", "", 'semi; and "double quotes"'];
  for (const entry of [launcher, join(root, "second")]) {
    const result = spawnSync(entry, args, { encoding: "utf8", cwd: root });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(args)}\n`);
  }
});

test("server launcher stops when its entry cannot be resolved", async () => {
  const root = await directory();
  const loop = join(root, "loop");
  await symlink("loop", loop);
  await mkdir(join(root, "runtime/bin"), { recursive: true });
  await writeFile(
    join(root, "runtime/bin/node"),
    "#!/bin/sh\nprintf 'CWD_RUNTIME_EXECUTED\\n'\nexit 23\n",
    { mode: 0o755 },
  );
  const result = spawnSync("sh", ["-c", script, loop, "--version"], {
    encoding: "utf8",
    cwd: root,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("CWD_RUNTIME_EXECUTED");
});
