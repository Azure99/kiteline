import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { appVersion } from "@kiteline/shared/protocol";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory() {
  const root = await mkdtemp("/var/tmp/kiteline-agent-main-");
  roots.push(root);
  return root;
}

function cli(root: string, args: string[]) {
  return promisify(execFile)(process.execPath, [resolve("packages/agent/dist/main.js"), ...args], {
    env: {
      ...process.env,
      KITELINE_AGENT_HOME: join(root, "data"),
      KITELINE_AGENT_RUN_DIR: join(root, "run"),
    },
    timeout: 5000,
  });
}

test("root help and version work without creating agent directories", async () => {
  const root = await directory();
  const help = await cli(root, []);
  expect(help.stdout).toContain("Usage: kiteline-agent");
  expect(help.stdout).toContain("Scheduled Tasks: kiteline-agent schedule --help");
  expect(help.stderr).toBe("");
  for (const option of ["--help", "-h"]) {
    expect(await cli(root, [option])).toEqual(help);
  }
  expect(await cli(root, ["--version"])).toMatchObject({
    stdout: `${appVersion}\n`,
    stderr: "",
  });
  expect(await readdir(root)).toEqual([]);
});

test("root help and version reject unknown commands and extra arguments", async () => {
  const root = await directory();
  for (const args of [
    ["nonsense"],
    ["nonsense", "--version"],
    ["--help", "unexpected"],
    ["-h", "unexpected"],
    ["--version", "unexpected"],
    ["--version", "--help"],
  ]) {
    const failure = await cli(root, args).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(/^Usage: kiteline-agent/),
    });
    expect(failure).toHaveProperty("stderr", expect.not.stringMatching(/^\s+at /m));
  }
  expect(await readdir(root)).toEqual([]);
});

test.each(["run", "check", "doctor"])(
  "%s rejects every trailing argument before creating agent directories or starting work",
  async (command) => {
    const root = await directory();
    for (const tail of ["--help", "--version", "unexpected"]) {
      const failure = await cli(root, [command, tail]).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringMatching(/^Usage: kiteline-agent/),
      });
      expect(failure).toHaveProperty("stderr", expect.not.stringMatching(/^\s+at /m));
    }
    expect(await readdir(root)).toEqual([]);
  },
);

test("subcommands handle version arguments with their existing exit codes", async () => {
  const root = await directory();
  await expect(cli(root, ["schedule", "list", "--version"])).rejects.toMatchObject({
    code: 2,
    stdout: "",
    stderr: expect.stringContaining("--version"),
  });
  await expect(cli(root, ["upgrade", "--archive", "--version"])).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining(
      process.platform === "win32" ? "kiteline-agent.ps1" : "--archive",
    ),
  });
  expect(await readdir(root)).toEqual([]);
});
