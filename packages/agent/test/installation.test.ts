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
import { agentLauncher } from "../../../scripts/agent-launcher.js";
import { lockFileDescriptor } from "../src/install/paths.js";
import { replaceProgram, writeLauncher } from "../src/install/commands.js";
import { lockAgentState } from "../src/state-lock.js";
import { unixInstallationLayout } from "../src/install/layout.js";

const cleanups: (() => Promise<unknown>)[] = [];
const installedPaths = {
  directory: unixInstallationLayout.directory,
  management: unixInstallationLayout.managementFile,
  managementFd: unixInstallationLayout.managementLockFd,
  use: unixInstallationLayout.useFile,
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-install-test-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function child(file: string, args: string[], env = process.env, cwd?: string) {
  const process = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
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
    managementFd: unixInstallationLayout.managementLockFd,
  };
  await mkdir(join(paths.directory, "runtime/bin"), { recursive: true });
  await mkdir(join(paths.directory, "agent/dist"), { recursive: true });
  await symlink(process.execPath, join(paths.directory, "runtime/bin/node"));
  await writeFile(join(paths.directory, "agent/dist/main.js"), main);
  await writeFile(paths.use, "");
  const path = join(root, "kiteline-agent");
  await writeFile(path, agentLauncher(paths.directory, paths, "linux"));
  await chmod(path, 0o755);
  return { ...paths, path };
}

test.each([
  ["linux", "portable"],
  ["linux", "installed"],
  ["darwin", "portable"],
  ["darwin", "installed"],
] as const)(
  "%s %s launcher preserves paths and arguments through relative links",
  async (platform, mode) => {
    const root = await directory();
    const source = join(root, "package with spaces, 'quotes' and $dollars");
    await mkdir(join(source, "bin"), { recursive: true });
    await mkdir(join(source, "runtime/bin"), { recursive: true });
    await mkdir(join(source, "agent/dist"), { recursive: true });
    await symlink(process.execPath, join(source, "runtime/bin/node"));
    await writeFile(
      join(source, "agent/dist/main.js"),
      "console.log(JSON.stringify(process.argv.slice(2)));",
    );
    await writeFile(
      join(source, "bin/kiteline-agent"),
      agentLauncher(mode === "installed" ? source : undefined, installedPaths, platform),
      {
        mode: 0o755,
      },
    );
    await symlink(
      "package with spaces, 'quotes' and $dollars/bin/kiteline-agent",
      join(root, "first"),
    );
    await symlink("first", join(root, "second"));
    const args = ["argument with 'quotes' and $dollars", "", 'semi; and "double quotes"'];
    for (const entry of [join(source, "bin/kiteline-agent"), join(root, "second")]) {
      const running = child(entry, args);
      expect((await running.closed)[0]).toBe(0);
      expect(running.output()).toBe(`${JSON.stringify(args)}\n`);
    }
  },
);

async function unresolvedLauncher(root: string, platform: NodeJS.Platform) {
  const paths = {
    directory: join(root, "installed"),
    management: join(root, "public/management.lock"),
    managementFd: unixInstallationLayout.managementLockFd,
    use: join(root, "use.lock"),
  };
  await mkdir(join(root, "runtime/bin"), { recursive: true });
  await writeFile(
    join(root, "runtime/bin/node"),
    "#!/bin/sh\nprintf 'CWD_RUNTIME_EXECUTED\\n'\nexit 23\n",
    { mode: 0o755 },
  );
  const loop = join(root, "loop");
  await symlink("loop", loop);
  return { script: agentLauncher(undefined, paths, platform), loop };
}

test.each(["linux", "darwin"] as const)(
  "%s portable launcher stops when its entry cannot be resolved",
  async (platform) => {
    const root = await directory();
    const entry = await unresolvedLauncher(root, platform);
    const running = child("sh", ["-c", entry.script, entry.loop, "--version"], process.env, root);
    expect((await running.closed)[0]).not.toBe(0);
    expect(running.output()).not.toContain("CWD_RUNTIME_EXECUTED");
  },
);

test.runIf(process.getuid?.() === 0).each(["linux", "darwin"] as const)(
  "%s portable install stops before creating management paths when its entry cannot be resolved",
  async (platform) => {
    const root = await directory();
    const entry = await unresolvedLauncher(root, platform);
    const running = child("sh", ["-c", entry.script, entry.loop, "install"], process.env, root);
    expect((await running.closed)[0]).not.toBe(0);
    expect(running.output()).not.toContain("CWD_RUNTIME_EXECUTED");
    await expect(access(join(root, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("portable launcher propagates a dirname failure without executing the cwd runtime", async () => {
  const root = await directory();
  const entry = await unresolvedLauncher(root, "linux");
  const path = join(root, "bin/kiteline-agent");
  const tools = join(root, "tools");
  await mkdir(join(root, "bin"));
  await mkdir(tools);
  await writeFile(path, entry.script, { mode: 0o755 });
  await writeFile(
    join(tools, "dirname"),
    '#!/bin/sh\n[ "$2" != "$TEST_ENTRY" ] || exit 41\ncommand -p dirname "$@"\n',
    { mode: 0o755 },
  );
  const running = child(
    path,
    ["--version"],
    { ...process.env, PATH: `${tools}:${process.env.PATH}`, TEST_ENTRY: path },
    root,
  );
  expect((await running.closed)[0]).toBe(41);
  expect(running.output()).not.toContain("CWD_RUNTIME_EXECUTED");
});

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
  const running = child(entry.path, ["run"]);
  await expect.poll(running.output).toContain("loaded");
  expect(spawnSync("flock", ["--exclusive", "--nonblock", entry.use, "true"]).status).toBe(1);
  running.process.kill("SIGTERM");
  await running.closed;
  const lock = await open(entry.use, "r");
  try {
    await lockFileDescriptor(lock.fd);
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
    if (spawnSync('flock', ['--exclusive', '--nonblock', '3'], {stdio:['ignore','ignore','ignore',${unixInstallationLayout.managementLockFd}]}).status !== 0) throw Error('management ownership lost');
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
  await expect(replaceProgram(current, replacement, previous, async () => {})).rejects.toThrow(
    "previous program was restored",
  );
  expect(await readFile(join(current, "version"), "utf8")).toBe("old");
});

test("program rollback restores the old tree when launcher publication fails", async () => {
  const root = await directory();
  const current = join(root, "program");
  const replacement = join(root, "new");
  const previous = join(root, "previous");
  await mkdir(current);
  await mkdir(replacement);
  await writeFile(join(current, "version"), "old");
  await writeFile(join(replacement, "version"), "new");
  await expect(
    replaceProgram(current, replacement, previous, () =>
      writeLauncher(join(root, "missing-directory", "launcher"), "new launcher"),
    ),
  ).rejects.toThrow("previous program was restored");
  expect(await readFile(join(current, "version"), "utf8")).toBe("old");
  await expect(access(previous)).rejects.toMatchObject({ code: "ENOENT" });
});

test("launcher publication failure preserves the existing file identity, contents and executable mode", async () => {
  const root = await directory();
  const launcher = join(root, "launcher");
  const contents = "#!/bin/sh\nprintf 'old launcher\\n'\n";
  await writeFile(launcher, contents, { mode: 0o755 });
  const before = await lstat(launcher);
  if (process.getuid?.() === 0) {
    // The unprivileged writer can create its pending file but cannot replace this root-owned entry.
    await chmod(root, 0o1777);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          const { writeLauncher } = await import(process.argv[1]);
          process.setgid(65534);
          process.setuid(65534);
          await assert.rejects(writeLauncher(process.argv[2], "new launcher"), {
            code: "EPERM",
            syscall: "rename",
            dest: process.argv[2],
          });
        `,
        new URL("../dist/install/commands.js", import.meta.url).href,
        launcher,
      ],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } else {
    await chmod(root, 0o555);
    try {
      await expect(writeLauncher(launcher, "new launcher")).rejects.toMatchObject({
        code: "EACCES",
        syscall: "open",
      });
    } finally {
      await chmod(root, 0o700);
    }
  }
  const after = await lstat(launcher);
  expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual({
    dev: before.dev,
    ino: before.ino,
    mode: before.mode,
  });
  expect(await readFile(launcher, "utf8")).toBe(contents);
  const executed = spawnSync(launcher, { encoding: "utf8" });
  expect(executed.status, executed.stderr).toBe(0);
  expect(executed.stdout).toBe("old launcher\n");
});
