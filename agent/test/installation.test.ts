import { afterEach, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { agentLauncher } from "../src/launcher.js";
import { lockFileDescriptor } from "../src/installation.js";
import { replaceProgram } from "../src/install.js";
import { lockAgentState } from "../src/state-lock.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-install-test-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function child(file: string, args: string[], env = process.env) {
  const process = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  process.stdout.on("data", (data) => {
    output += data.toString();
  });
  process.stderr.on("data", (data) => {
    output += data.toString();
  });
  const closed = once(process, "close");
  cleanups.push(async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
    await closed;
  });
  return { process, closed, output: () => output };
}
async function launcher(root: string, main: string) {
  const paths = {
    directory: join(root, "program"),
    use: join(root, "use.lock"),
    management: join(root, "public/management.lock"),
  };
  await mkdir(join(paths.directory, "runtime/bin"), { recursive: true });
  await mkdir(join(paths.directory, "agent/dist"), { recursive: true });
  await symlink(process.execPath, join(paths.directory, "runtime/bin/node"));
  await writeFile(join(paths.directory, "agent/dist/main.js"), main);
  await writeFile(paths.use, "");
  const path = join(root, "kiteline-agent");
  await writeFile(path, agentLauncher(paths.directory, paths));
  await chmod(path, 0o755);
  return { ...paths, path };
}

test("application state excludes another owner until cleanup releases it", async () => {
  const root = await directory();
  const release = await lockAgentState(root);
  try {
    await expect(lockAgentState(root)).rejects.toMatchObject({ code: "ELOCKED" });
  } finally {
    await release();
  }
  await (
    await lockAgentState(root)
  )();
});

test("every installed command holds a shared lock before loading program files", async () => {
  const root = await directory();
  const entry = await launcher(root, 'console.log("loaded"); setInterval(() => {}, 1000);');
  const running = child(entry.path, ["attach", "test"]);
  await expect.poll(running.output).toContain("loaded");
  expect(spawnSync("flock", ["--exclusive", "--nonblock", entry.use, "true"]).status).toBe(1);
  running.process.kill("SIGTERM");
  await running.closed;
  const lock = await open(entry.use, "r");
  try {
    await lockFileDescriptor(lock.fd, "exclusive");
    const blocked = child(entry.path, ["--version"]);
    expect((await blocked.closed)[0]).toBe(1);
    expect(blocked.output()).not.toContain("loaded");
    expect(blocked.output()).toContain("installation is being changed");
  } finally {
    await lock.close();
  }
});

test.runIf(process.getuid?.() === 0).each([false, true])(
  "maintenance waits outside a removed launcher and retains its lock (interrupted=%s)",
  async (interrupt) => {
    const root = await directory();
    const entry = await launcher(
      root,
      `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    process.on('SIGTERM', () => {});
    if (spawnSync('flock', ['--exclusive', '--nonblock', '3'], {stdio:['ignore','ignore','ignore',9]}).status !== 0) throw Error('management ownership lost');
    fs.unlinkSync(process.env.TEST_LAUNCHER);
    console.log('stdin=' + fs.readFileSync(0, 'utf8'));
    console.log('ready ' + __dirname);
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.TEST_GATE)) return;
      clearInterval(timer);
      console.log(fs.readFileSync(process.env.TEST_INPUT, 'utf8'));
      process.exitCode = 37;
    }, 10);
  `,
    );
    const input = join(root, "input");
    const gate = join(root, "continue");
    if (interrupt) await mkdir(join(root, "public"), { mode: 0o710 });
    await writeFile(input, "input retained");
    const running = child(entry.path, ["upgrade"], {
      ...process.env,
      TEST_LAUNCHER: entry.path,
      TEST_GATE: gate,
      TEST_INPUT: input,
    });
    running.process.stdin.end("stdin retained");
    // Ensure a failed assertion cannot leave the transaction waiting for test input.
    cleanups.push(() => writeFile(gate, "go"));
    await expect.poll(running.output).toContain("ready ");
    expect((await lstat(join(root, "public"))).mode & 0o777).toBe(interrupt ? 0o710 : 0o755);
    expect((await lstat(entry.management)).mode & 0o777).toBe(0o600);
    const copied = running.output().match(/ready (.+)\/package\/agent\/dist/)!;
    expect((await lstat(copied[1]!)).mode & 0o777).toBe(0o700);
    expect(spawnSync("flock", ["--exclusive", "--nonblock", entry.management, "true"]).status).toBe(
      1,
    );
    if (interrupt) running.process.kill("SIGTERM");
    await writeFile(gate, "go");
    expect((await running.closed)[0]).toBe(interrupt ? 143 : 37);
    expect(running.output()).toContain("input retained");
    expect(running.output()).toContain("stdin=stdin retained");
    await expect(access(copied[1]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawnSync("flock", ["--exclusive", "--nonblock", entry.management, "true"]).status).toBe(
      0,
    );
  },
);

test("program rollback restores the old tree when replacement publication fails", async () => {
  const root = await directory();
  const current = join(root, "program"),
    replacement = join(root, "new"),
    previous = join(root, "previous");
  await mkdir(current);
  await writeFile(join(current, "version"), "old");
  // The second rename fails before any replacement is published.
  await expect(
    replaceProgram(
      current,
      replacement,
      previous,
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow("previous program was restored");
  expect(await readFile(join(current, "version"), "utf8")).toBe("old");
});
