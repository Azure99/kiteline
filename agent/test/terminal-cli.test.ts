import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { serverFixture } from "../../server/test/fixture.js";
import { Agent } from "../src/agent.js";
import { localRequest } from "../src/local.js";
import { testConfig } from "./support/config.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [resolve("agent/dist/main.js"), ...args], {
      env: {
        ...process.env,
        KITELINE_AGENT_HOME: root,
        KITELINE_AGENT_RUN_DIR: join(root, "run"),
      },
    });

  const created = await run("terminal", "new", "--workspace", workspace.id);
  expect(created.stdout).toMatch(/^[a-f0-9]{16}\n$/);
  const id = created.stdout.trim();
  expect((await run("terminal", "list")).stdout).toContain(`${id}\t${workspace.id}\t`);
  await expect(
    run("terminal", "new", "--workspace", workspace.id, "--no-attach"),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--no-attach") });
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
