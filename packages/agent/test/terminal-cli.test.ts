import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { OperationError } from "@kiteline/shared/protocol";
import { serverFixture } from "../../server/test/fixture.js";
import { Agent } from "../src/agent.js";
import { LocalServer, localRequest } from "../src/local.js";
import { testConfig } from "./support/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function cli(root: string, ...args: string[]) {
  return promisify(execFile)(process.execPath, [resolve("packages/agent/dist/main.js"), ...args], {
    env: {
      ...process.env,
      KITELINE_AGENT_HOME: root,
      KITELINE_AGENT_RUN_DIR: join(root, "run"),
    },
  });
}

test("terminal commands create without a TTY and no longer expose local attach", async () => {
  const server = await serverFixture();
  cleanups.push(server.close);
  const root = await mkdtemp("/var/tmp/kiteline-terminal-cli-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = testConfig(root);
  await mkdir(config.runDir);
  const binding = server.store.newBinding();
  const identity = { ...server.store.bind(binding.code, "CLI test"), server: server.origin };
  const agent = new Agent(config, identity);
  cleanups.push(() => agent.close());
  const workspace = await agent.metadata.add(root);
  await agent.start();
  const run = (...args: string[]) => cli(root, ...args);

  expect(await run("workspace", "list")).toMatchObject({
    stdout: `${workspace.id}\t${workspace.name}\t${workspace.path}\n`,
    stderr: "",
  });
  const created = await run("terminal", "new", "--workspace", workspace.id);
  expect(created.stdout).toMatch(/^[a-f0-9]{16}\n$/);
  expect(created.stderr).toBe("");
  const id = created.stdout.trim();
  expect((await run("terminal", "list")).stdout).toContain(`${id}\t${workspace.id}\t`);
  await expect(
    run("terminal", "new", "--workspace", workspace.id, "--no-attach"),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringMatching(/^io_error: .*--no-attach.*\n$/),
  });
  expect(agent.sessions.list().sessions.map((session) => session.id)).toEqual([id]);
  await expect(run("attach", id)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Usage: kiteline-agent"),
  });
  await expect(localRequest(config, "terminal.attach", { sessionId: id })).rejects.toMatchObject({
    code: "unsupported",
  });
  await run("terminal", "end", id);
  expect((await run("terminal", "list")).stdout).toBe("");
}, 15000);

test("local CLI reports unknown results and retains only a returned session ID", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-terminal-cli-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = testConfig(root);
  await mkdir(config.runDir);
  const local = new LocalServer(config, async (method) => {
    if (method === "sessions.create")
      throw new OperationError("io_error", "Create confirmation lost", "unknown", {
        sessionId: "created-session",
      });
    if (method === "sessions.end")
      throw new OperationError("io_error", "End confirmation lost", "unknown");
    throw new OperationError("invalid_argument", "Workspace request rejected", "failed");
  });
  cleanups.push(() => local.close());
  await local.start();
  await expect(cli(root, "terminal", "new", "--workspace", "workspace")).rejects.toMatchObject({
    code: 3,
    stdout: "",
    stderr: "io_error: Create confirmation lost (sessionId=created-session)\n",
  });
  await expect(cli(root, "terminal", "end", "argument-session")).rejects.toMatchObject({
    code: 3,
    stdout: "",
    stderr: "io_error: End confirmation lost\n",
  });
  await expect(cli(root, "workspace", "list")).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: "invalid_argument: Workspace request rejected\n",
  });
});

test("local CLI formats configuration failures before opening IPC", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-terminal-cli-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "config.json"), JSON.stringify({ shell: "relative" }));
  await expect(cli(root, "workspace", "list")).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: "invalid_argument: Shell must be an absolute path\n",
  });
});
