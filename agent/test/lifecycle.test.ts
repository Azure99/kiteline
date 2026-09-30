import { expect, test, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent } from "../src/control.js";
import { defaultAgentLimits } from "../src/config.js";
import { ScheduledTasks } from "../src/tasks/index.js";

test("stopping during schedule load prevents late timers and local admission, and waits once", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-startup-test-");
  const config = {
    dataDir: root,
    runDir: join(root, "run"),
    shell: "/bin/sh",
    limits: defaultAgentLimits,
  };
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
    const starting = agent.start();
    await expect.poll(() => paused.mock.calls.length).toBe(1);
    let closed = false;
    const closing = agent.close();
    expect(agent.close()).toBe(closing);
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

test.runIf(process.platform === "linux")(
  "real main handles repeated stop while configuration I/O is pending",
  async () => {
    const root = await mkdtemp("/var/tmp/kiteline-main-stop-");
    const file = join(root, "config.json");
    execFileSync("mkfifo", [file]);
    const child = spawn(process.execPath, [resolve("agent/dist/main.js"), "run"], {
      env: { ...process.env, KITELINE_AGENT_HOME: root, KITELINE_AGENT_RUN_DIR: join(root, "run") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ended = once(child, "close");
    let output = "";
    child.stderr.on("data", (part) => {
      output += part.toString();
    });
    try {
      // Opening the writer unblocks the real reader but deliberately withholds JSON.
      const { open } = await import("node:fs/promises");
      const writer = await open(file, "w");
      try {
        await expect
          .poll(async () => {
            const directory = `/proc/${child.pid}/fd`;
            const files = await readdir(directory);
            return (
              await Promise.all(files.map((fd) => readlink(join(directory, fd)).catch(() => "")))
            ).includes(file);
          })
          .toBe(true);
        child.kill("SIGTERM");
        child.kill("SIGHUP");
        await writer.write("{}");
      } finally {
        await writer.close();
      }
      expect((await ended)[0], output).toBe(0);
      await expect(access(join(root, "process.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, "run"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await ended;
      await rm(root, { recursive: true, force: true });
    }
  },
);
