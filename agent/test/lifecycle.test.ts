import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent.js";
import { privateDirectory } from "../src/config.js";
import { testConfig } from "./support/config.js";
import { ScheduledTasks } from "../src/tasks/index.js";
import { localRequest } from "../src/local.js";

test.runIf(process.platform !== "win32")(
  "real main owns its runtime directory until normal cleanup completes",
  async () => {
    const root = await mkdtemp("/var/tmp/kiteline-runtime-owner-");
    const other = join(root, "other");
    const config = testConfig(root, { runDir: root });
    const children: { child: ReturnType<typeof spawn>; ended: ReturnType<typeof once> }[] = [];
    function start(dataDir: string) {
      const child = spawn(process.execPath, [resolve("agent/dist/main.js"), "run"], {
        env: { ...process.env, KITELINE_AGENT_HOME: dataDir, KITELINE_AGENT_RUN_DIR: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (part) => {
        output += part.toString();
      });
      child.stderr.on("data", (part) => {
        output += part.toString();
      });
      const running = { child, ended: once(child, "close"), output: () => output };
      children.push(running);
      return running;
    }
    try {
      const unbound = start(root);
      expect((await unbound.ended)[0], unbound.output()).toBe(1);
      expect(unbound.output()).toContain("Device is not bound");
      await mkdir(other);
      const identity = JSON.stringify({
        deviceId: "runtime-test",
        deviceToken: "runtime-test",
        server: "http://127.0.0.1:1",
      });
      for (const dataDir of [root, other])
        await writeFile(join(dataDir, "connection.json"), identity);
      const first = start(root);
      await expect.poll(() => localRequest(config, "workspaces.list")).toEqual({ workspaces: [] });
      const blocked = start(other);
      expect((await blocked.ended)[0], blocked.output()).toBe(1);
      expect(blocked.output()).toContain("ELOCKED");
      expect(await localRequest(config, "workspaces.list")).toEqual({ workspaces: [] });
      first.child.kill("SIGTERM");
      expect((await first.ended)[0], first.output()).toBe(0);
      const next = start(other);
      await expect.poll(() => localRequest(config, "workspaces.list")).toEqual({ workspaces: [] });
      next.child.kill("SIGTERM");
      expect((await next.ended)[0], next.output()).toBe(0);
    } finally {
      for (const running of children) {
        if (running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill("SIGTERM");
        await running.ended;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("stopping during schedule load prevents late timers and local admission, and waits once", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-startup-test-");
  const config = testConfig(root);
  const saved = new ScheduledTasks(config);
  const agent = new Agent(config, {
    deviceId: "test",
    deviceToken: "test",
    server: "http://127.0.0.1:1",
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const load = agent.schedules.load.bind(agent.schedules);
  const paused = vi.spyOn(agent.schedules, "load").mockImplementation(async () => {
    await held;
    await load();
  });
  try {
    await saved.load();
    await saved.create(
      "once",
      {
        name: "once",
        command: "printf no > should-not-run",
        cwd: root,
        timezone: "UTC",
        schedule: { kind: "once", at: new Date(Date.now() + 500).toISOString() },
      },
      new AbortController().signal,
    );
    await saved.close();
    for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
    const starting = agent.start();
    await expect.poll(() => paused.mock.calls.length).toBe(1);
    let closed = false;
    const closing = agent.close();
    void closing.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    resume();
    await Promise.all([starting, closing]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(access(join(root, "should-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(config.runDir, "agent.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      agent.dispatch("sessions.list", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  } finally {
    resume();
    paused.mockRestore();
    await agent.close();
    await saved.close();
    await rm(root, { recursive: true, force: true });
  }
});
