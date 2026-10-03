import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, renameSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  lstat,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { taskRunActive, type ScheduledTask, type TaskRun } from "@kiteline/shared/protocol";
import { defaultAgentLimits, privateDirectory } from "../src/config.js";
import { ScheduledTasks } from "../src/tasks/index.js";
import { checkSchedule, checkTimezone, nextOccurrence } from "../src/tasks/schedule.js";
import { scheduleMethods, scheduleRpc, type ScheduleMethod } from "../src/tasks/rpc.js";
import { LocalServer } from "../src/local.js";
import { Agent } from "../src/agent.js";
import { localRequest } from "../src/local.js";

const signal = new AbortController().signal;
const input = (cwd: string, command = "printf '你好'; printf error >&2") => ({
  name: "Daily",
  command,
  cwd,
  timezone: "UTC",
  schedule: { kind: "cron", expression: "0 9 * * *" },
});

async function fixture(limits = {}) {
  const root = await mkdtemp("/var/tmp/kiteline-schedule-test-");
  const config = {
    dataDir: root,
    runDir: join(root, "run"),
    shell: "/bin/bash",
    limits: { ...defaultAgentLimits, ...limits },
  };
  const tasks = new ScheduledTasks(config);
  await tasks.load();
  return {
    root,
    config,
    tasks,
    async close() {
      await tasks.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function finished(tasks: ScheduledTasks, id: string, timeout = 8000) {
  await expect.poll(() => taskRunActive(tasks.run(id).state), { timeout }).toBe(false);
  return tasks.run(id);
}

test("case-equivalent identities are rejected while original IDs survive restart and deletion", async () => {
  const f = await fixture();
  let restored: ScheduledTasks | undefined;
  try {
    await f.tasks.create("ReviewTask", input(f.root, "printf result"), signal);
    const path = join(f.root, "tasks", "ReviewTask.json");
    const before = await readFile(path, "utf8");
    await expect(f.tasks.create("reviewtask", input(f.root), signal)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(path, "utf8")).toBe(before);
    await f.tasks.create("Other", input(f.root), signal);
    await f.tasks.start("ReviewTask", "ReviewRun", signal);
    await finished(f.tasks, "ReviewRun");
    await expect(f.tasks.start("Other", "reviewrun", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(() => f.tasks.get("reviewtask")).toThrow("does not exist");
    expect(() => f.tasks.run("reviewrun")).toThrow("does not exist");
    await f.tasks.close();
    restored = new ScheduledTasks(f.config);
    await restored.load();
    expect(restored.get("ReviewTask").id).toBe("ReviewTask");
    expect(restored.run("ReviewRun").taskId).toBe("ReviewTask");
    expect((await restored.output("ReviewRun", "stdout", 0, 32, signal)).text).toBe("result");
    await restored.delete("ReviewTask", undefined, signal);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.root, "tasks", "ReviewRun.stdout"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(restored.get("Other").id).toBe("Other");
  } finally {
    await restored?.close();
    await f.close();
  }
});

test("scheduled command admission, pause, immutable parameters, revision and bounded records", async () => {
  const f = await fixture({ taskHistoryRuns: 2 });
  try {
    const task = await f.tasks.create(
      "task",
      input(f.root, "sleep .3; printf '你好'; printf error >&2; exit 7"),
      signal,
    );
    const abort = new AbortController();
    const run = await f.tasks.start(task.id, "first", abort.signal);
    abort.abort();
    await expect(f.tasks.start(task.id, "overlap", signal)).rejects.toMatchObject({ code: "busy" });
    await expect(f.tasks.start(task.id, "first", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    const paused = await f.tasks.setPaused(task.id, true, signal);
    await expect(
      f.tasks.update(task.id, task.revision, { name: "stale" }, signal),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.tasks.update(task.id, paused.revision, { command: "printf second" }, signal);
    const result = await finished(f.tasks, run.id);
    expect(result).toMatchObject({
      state: "failed",
      exitCode: 7,
      parameters: { command: task.command },
    });
    expect(await f.tasks.output(run.id, "stdout", 0, 4, signal)).toMatchObject({
      text: "你",
      nextOffset: 3,
      storedBytes: 6,
    });
    expect(await f.tasks.output(run.id, "stdout", 3, 4, signal)).toMatchObject({
      text: "好",
      nextOffset: 6,
    });
    expect((await f.tasks.output(run.id, "stderr", 0, 32, signal)).text).toBe("error");
    for (const id of ["second", "third"]) {
      await f.tasks.start(task.id, id, signal);
      await finished(f.tasks, id);
    }
    expect(f.tasks.runs(task.id).total).toBe(2);
    expect(() => f.tasks.run("first")).toThrow("does not exist or has been cleaned up");
    expect(f.tasks.get(task.id).state).toBe("paused");
    await f.tasks.update(task.id, f.tasks.get(task.id).revision, { command: "true" }, signal);
    for (const id of ["empty-first", "empty-second", "empty-third"]) {
      await f.tasks.start(task.id, id, signal);
      await finished(f.tasks, id);
    }
    expect(f.tasks.runs(task.id).total).toBe(2);
    expect(() => f.tasks.run("empty-first")).toThrow("does not exist or has been cleaned up");
    expect(f.tasks.run("empty-second").output.stdoutBytes).toBe(0);
    await f.tasks.delete(task.id, undefined, signal);
    expect(f.tasks.list().total).toBe(0);
  } finally {
    await f.close();
  }
});

test("stored task results retain full Windows DWORD process IDs and exit codes", async () => {
  const f = await fixture();
  let reloaded: ScheduledTasks | undefined;
  try {
    await f.tasks.create("wide", input(f.root, "exit 0"), signal);
    await f.tasks.start("wide", "wide-run", signal);
    await finished(f.tasks, "wide-run");
    await f.tasks.close();
    const path = join(f.root, "tasks", "wide.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    Object.assign(record.runs[0], { pid: 0xffffffff, exitCode: 0xc0000005, state: "failed" });
    await writeFile(path, JSON.stringify(record));
    reloaded = new ScheduledTasks(f.config);
    await reloaded.load();
    expect(reloaded.run("wide-run")).toMatchObject({
      pid: 0xffffffff,
      exitCode: 0xc0000005,
      state: "failed",
    });
  } finally {
    await reloaded?.close();
    await f.close();
  }
});

test("real one-shot timers skip overlaps and persist consumption independently of manual runs", async () => {
  const f = await fixture();
  try {
    const at = new Date(Date.now() + 500).toISOString();
    const task = await f.tasks.create(
      "once",
      { ...input(f.root, "sleep 1; printf done"), schedule: { kind: "once", at } },
      signal,
    );
    await f.tasks.start(task.id, "manual", signal);
    await expect.poll(() => f.tasks.get(task.id).onceStatus).toBe("consumed");
    expect(f.tasks.runs(task.id).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "skipped", reasonCode: "overlap" }),
      ]),
    );
    await finished(f.tasks, "manual");
    await f.tasks.close();
    const restored = new ScheduledTasks(f.config);
    try {
      await restored.load();
      expect(restored.get(task.id)).toMatchObject({ onceStatus: "consumed", nextRunAt: null });
      await restored.update(
        task.id,
        restored.get(task.id).revision,
        { name: "new name", timezone: "Asia/Shanghai" },
        signal,
      );
      expect(restored.get(task.id).onceStatus).toBe("consumed");
      const expired = await restored.create(
        "missed",
        {
          ...input(f.root),
          schedule: { kind: "once", at: new Date(Date.now() + 100).toISOString() },
        },
        signal,
      );
      await restored.setPaused(expired.id, true, signal);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await restored.setPaused(expired.id, false, signal);
      expect(restored.get(expired.id)).toMatchObject({ onceStatus: "missed", nextRunAt: null });
      await restored.start(expired.id, "after-missed", signal);
      expect((await finished(restored, "after-missed")).state).toBe("succeeded");
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

test("management of expired paused one-shot tasks keeps skipped history bounded", async () => {
  const f = await fixture({ taskHistoryRuns: 1 });
  try {
    await f.tasks.create("paused", input(f.root), signal);
    await f.tasks.setPaused("paused", true, signal);
    for (let index = 0; index < 4; index++) {
      await f.tasks.update(
        "paused",
        f.tasks.get("paused").revision,
        { schedule: { kind: "once", at: new Date(Date.now() + 180).toISOString() } },
        signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
      if (index % 2) await f.tasks.setPaused("paused", true, signal);
      else
        await f.tasks.update(
          "paused",
          f.tasks.get("paused").revision,
          { name: `Paused ${index}` },
          signal,
        );
      expect(f.tasks.runs("paused")).toMatchObject({
        total: 1,
        items: [{ state: "skipped", reasonCode: "missed" }],
      });
    }
  } finally {
    await f.close();
  }
});

test("DST uses matching wall times, timezone and five-field rules are validated", async () => {
  for (const at of ["January 01 2027Z", "2027-02-30T09:00:00+08:00", "2027-02-29T09:00:00Z"])
    expect(() => checkSchedule({ kind: "once", at })).toThrow("ISO timestamp");
  expect(() => checkTimezone("+08:00")).toThrow("IANA timezone");
  const cron = { kind: "cron" as const, expression: "30 2 * * *" };
  expect(
    nextOccurrence(cron, "America/New_York", new Date("2027-03-14T05:00:00Z"))?.toISOString(),
  ).toBe("2027-03-15T06:30:00.000Z");
  const fall = { kind: "cron" as const, expression: "30 1 * * *" };
  expect(
    nextOccurrence(fall, "America/New_York", new Date("2027-11-07T05:30:00Z"))?.toISOString(),
  ).toBe("2027-11-08T06:30:00.000Z");
  const f = await fixture();
  try {
    await expect(
      f.tasks.create("zone", { ...input(f.root), timezone: "Missing/Zone" }, signal),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      f.tasks.create(
        "fields",
        { ...input(f.root), schedule: { kind: "cron", expression: "* * * * * *" } },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  } finally {
    await f.close();
  }
});

test("manual admission does not erase an already-due timer callback", async () => {
  const f = await fixture();
  try {
    const at = new Date(Date.now() + 100).toISOString();
    await f.tasks.create(
      "due",
      { ...input(f.root, "sleep .4"), schedule: { kind: "once", at } },
      signal,
    );
    // Hold the event loop until the timer is due, then issue a manual action before timers run.
    while (Date.now() < Date.parse(at) + 25) {
      /* Intentional brief event-loop stall. */
    }
    await f.tasks.start("due", "manual", signal);
    await expect.poll(() => f.tasks.get("due").onceStatus).toBe("consumed");
    expect(f.tasks.runs("due").items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "skipped", reasonCode: "overlap", scheduledAt: at }),
      ]),
    );
  } finally {
    await f.close();
  }
});

test("output shares a finite budget across streams, drains after truncation and reports disk errors independently", async () => {
  const f = await fixture({ taskOutputBytes: 64, taskOutputTotalBytes: 64 });
  try {
    await f.tasks.create(
      "output",
      input(f.root, "head -c 1000000 /dev/zero; head -c 1000000 /dev/zero >&2"),
      signal,
    );
    await f.tasks.start("output", "large", signal);
    const run = await finished(f.tasks, "large");
    expect(run.state).toBe("succeeded");
    expect(run.output.stdoutBytes + run.output.stderrBytes).toBe(64);
    expect(run.output.truncated).toBe(true);
    await mkdir(join(f.root, "tasks", "bad.stdout"));
    await f.tasks.start("output", "bad", signal);
    const bad = await finished(f.tasks, "bad");
    expect(bad.state).toBe("succeeded");
    expect(bad.output.error).toContain("EEXIST");
    expect(() => f.tasks.run("large")).toThrow();
  } finally {
    await f.close();
  }
});

test("explicit stop kills a TERM-ignoring foreground child before releasing the task slot", async () => {
  const f = await fixture({ taskRunsPerDevice: 1 });
  try {
    await f.tasks.create("stop", input(f.root, "trap '' TERM; sleep 60 & echo $!; wait"), signal);
    await f.tasks.create("other", input(f.root), signal);
    await f.tasks.start("stop", "running", signal);
    await expect
      .poll(async () => (await f.tasks.output("running", "stdout", 0, 128, signal)).text)
      .toMatch(/\d+/);
    await expect(f.tasks.start("other", "capacity", signal)).rejects.toMatchObject({
      code: "busy",
    });
    await f.tasks.stop("running", signal);
    expect(f.tasks.run("running").state).toBe("stopping");
    await expect(f.tasks.start("stop", "before-cleanup", signal)).rejects.toMatchObject({
      code: "busy",
    });
    expect(await finished(f.tasks, "running")).toMatchObject({
      state: "stopped",
      reasonCode: "requested_stop",
      signal: "SIGKILL",
    });
    await f.tasks.start("other", "after-cleanup", signal);
    expect((await finished(f.tasks, "after-cleanup")).state).toBe("succeeded");
  } finally {
    await f.close();
  }
}, 15000);

test("a crashed Shell does not release a still-running foreground process group", async () => {
  const f = await fixture();
  try {
    await f.tasks.create(
      "group",
      input(f.root, "sleep 60 >/dev/null 2>&1 & echo $!; wait"),
      signal,
    );
    const run = await f.tasks.start("group", "leader", signal);
    await expect
      .poll(async () => (await f.tasks.output(run.id, "stdout", 0, 128, signal)).text)
      .toMatch(/\d+/);
    process.kill(run.pid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(taskRunActive(f.tasks.run(run.id).state)).toBe(true);
    await expect(f.tasks.start("group", "blocked", signal)).rejects.toMatchObject({ code: "busy" });
    await f.tasks.stop(run.id, signal);
    expect((await finished(f.tasks, run.id)).state).toBe("stopped");
  } finally {
    await f.close();
  }
});

test("escaped descendants do not hold task output open indefinitely", async () => {
  const f = await fixture();
  let escaped: number | undefined;
  try {
    await f.tasks.create(
      "escape",
      input(f.root, "setsid sh -c 'echo $$ > escaped.pid; exec sleep 30' &"),
      signal,
    );
    await f.tasks.start("escape", "escaped", signal);
    await expect
      .poll(async () => {
        escaped = Number(await readFile(join(f.root, "escaped.pid"), "utf8"));
        return escaped;
      })
      .toBeGreaterThan(0);
    expect(await finished(f.tasks, "escaped", 4000)).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      output: { error: expect.stringContaining("pipes did not close") },
    });
    expect(process.kill(escaped!, 0)).toBe(true);
  } finally {
    if (escaped) process.kill(-escaped, "SIGKILL");
    await f.close();
  }
});

test("spawn failure has no command exit code or start time", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "removed");
    await mkdir(cwd);
    await f.tasks.create("missing", input(cwd), signal);
    await rm(cwd, { recursive: true });
    await f.tasks.start("missing", "no-process", signal);
    const result = await finished(f.tasks, "no-process");
    expect(result).toMatchObject({ state: "failed", reasonCode: "start_failed", exitCode: null });
    expect(result.startedAt).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("stop queued by the terminal notification cannot change a completed run back to stopping", async () => {
  const f = await fixture();
  let stopped: Promise<TaskRun> | undefined;
  try {
    await f.tasks.create("task", input(f.root), signal);
    f.tasks.onChange = (snapshot) => {
      if (snapshot.items[0]?.latestRun?.state === "succeeded")
        stopped ??= f.tasks.stop("run", signal);
    };
    await f.tasks.start("task", "run", signal);
    await expect.poll(() => stopped).toBeDefined();
    expect(await stopped).toMatchObject({ state: "succeeded", exitCode: 0 });
    expect(f.tasks.run("run").state).toBe("succeeded");
    expect(
      JSON.parse(await readFile(join(f.root, "tasks", "task.json"), "utf8")).runs[0].state,
    ).toBe("succeeded");
  } finally {
    await f.close();
  }
});

test("lowered byte limits preserve old output; actual shortening resets reads", async () => {
  const f = await fixture({ taskOutputBytes: 64, taskOutputTotalBytes: 128 });
  try {
    await f.tasks.create("limits", input(f.root, "head -c 64 /dev/zero"), signal);
    await f.tasks.start("limits", "one", signal);
    await finished(f.tasks, "one");
    expect(f.tasks.run("one").output.truncated).toBe(false);
    await f.tasks.close();
    await truncate(join(f.root, "tasks", "one.stdout"), 32);
    const shortened = new ScheduledTasks(f.config);
    try {
      await shortened.load();
      expect(shortened.run("one").output).toMatchObject({ stdoutBytes: 32, truncated: true });
      expect(await shortened.output("one", "stdout", 64, 32, signal)).toMatchObject({
        offset: 0,
        nextOffset: 32,
        storedBytes: 32,
      });
      await rm(join(f.root, "tasks", "one.stdout"));
      expect(await shortened.output("one", "stdout", 32, 32, signal)).toMatchObject({
        offset: 0,
        nextOffset: 0,
        storedBytes: 0,
        text: "",
      });
      await writeFile(join(f.root, "tasks", "one.stdout"), Buffer.alloc(32));
    } finally {
      await shortened.close();
    }
    const smaller = new ScheduledTasks({
      ...f.config,
      limits: { ...f.config.limits, taskOutputBytes: 16, taskOutputTotalBytes: 8 },
    });
    try {
      await smaller.load();
      expect(smaller.runs("limits").total).toBe(1);
      expect(smaller.run("one").output).toMatchObject({ stdoutBytes: 32, truncated: true });
      expect((await readFile(join(f.root, "tasks", "one.stdout"))).length).toBe(32);
    } finally {
      await smaller.close();
    }
  } finally {
    await f.close();
  }
});

test("lowered task count preserves existing management and prevents new definitions", async () => {
  const f = await fixture();
  let restored: ScheduledTasks | undefined;
  try {
    await f.tasks.create("good", input(f.root), signal);
    await f.tasks.create("existing", input(f.root, "printf retained"), signal);
    await f.tasks.start("existing", "retained", signal);
    await finished(f.tasks, "retained");
    await f.tasks.close();
    restored = new ScheduledTasks({
      ...f.config,
      limits: { ...f.config.limits, tasksPerDevice: 1 },
    });
    await restored.load();
    expect(restored.list().total).toBe(2);
    await restored.update(
      "good",
      restored.get("good").revision,
      { name: "Still editable" },
      signal,
    );
    await expect(restored.create("new", input(f.root), signal)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    await expect(restored.create("existing", input(f.root), signal)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(restored.start("good", "retained", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    await restored.start("good", "allowed", signal);
    expect((await finished(restored, "allowed")).state).toBe("succeeded");
    expect(await readFile(join(f.root, "tasks", "retained.stdout"), "utf8")).toBe("retained");
  } finally {
    await restored?.close();
    await f.close();
  }
});

test("active output prevents eviction that cannot reclaim a full run budget", async () => {
  const f = await fixture({ taskOutputBytes: 64, taskOutputTotalBytes: 100 });
  try {
    await f.tasks.create("history", input(f.root, "head -c 20 /dev/zero"), signal);
    await f.tasks.create("active", input(f.root, "head -c 64 /dev/zero; sleep 30"), signal);
    await f.tasks.create("next", input(f.root, "head -c 64 /dev/zero"), signal);
    await f.tasks.start("history", "old", signal);
    const old = await finished(f.tasks, "old");
    await f.tasks.start("active", "running", signal);
    await expect
      .poll(async () => (await f.tasks.output("running", "stdout", 0, 64, signal)).storedBytes)
      .toBe(64);
    await f.tasks.start("next", "new", signal);
    expect(await finished(f.tasks, "new")).toMatchObject({
      state: "succeeded",
      output: { stdoutBytes: 16, truncated: true },
    });
    expect(f.tasks.run("old")).toEqual(old);
    expect((await readFile(join(f.root, "tasks", "old.stdout"))).length).toBe(20);
    expect(f.tasks.run("running").state).toBe("running");
  } finally {
    await f.close();
  }
});

test("broken JSON disables every task RPC before any startup write while the real agent stays usable", async () => {
  const f = await fixture();
  let agent: Agent | undefined;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.tasks.create("good", input(f.root), signal);
    await f.tasks.create("bad", input(f.root), signal);
    await f.tasks.start("good", "before", signal);
    await finished(f.tasks, "before");
    await f.tasks.close();
    const directory = join(f.root, "tasks");
    const goodPath = join(directory, "good.json");
    const good = JSON.parse(await readFile(goodPath, "utf8"));
    Object.assign(good.task, {
      schedule: { kind: "once", at: "2000-01-01T00:00:00.000Z" },
      onceStatus: "pending",
      nextRunAt: "2000-01-01T00:00:00.000Z",
    });
    good.runs[0].state = "running";
    delete good.runs[0].endedAt;
    await writeFile(goodPath, JSON.stringify(good));
    const path = join(f.root, "tasks", "bad.json");
    await writeFile(path, "{");
    await writeFile(join(f.root, "tasks", "unclaimed.stdout"), "Do not delete");
    await writeFile(join(directory, "unfinished.tmp"), "Unpublished record");
    const original = new Map(
      await Promise.all(
        (await readdir(directory, { recursive: true })).map(
          async (file) =>
            [
              file,
              (await lstat(join(directory, file))).isFile()
                ? await readFile(join(directory, file))
                : null,
            ] as const,
        ),
      ),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      agent = new Agent(f.config, {
        deviceId: "test",
        deviceToken: "test",
        server: "http://127.0.0.1:1",
      });
      for (const path of [agent.config.dataDir, agent.config.runDir]) await privateDirectory(path);
      await agent.start();
      expect(await localRequest(f.config, "workspaces.list")).toEqual({ workspaces: [] });
      for (const method of scheduleMethods)
        await expect(localRequest(f.config, method)).rejects.toMatchObject({
          code: "io_error",
          message: "Scheduled task storage is unavailable",
          details: undefined,
        });
      expect(agent.schedules.snapshot()).toEqual({ revision: 0, storageError: true, items: [] });
      expect(agent.schedules.status().storageError).toBeTruthy();
      if (attempt === 0)
        for (const args of [
          ["list"],
          ["show", "good"],
          ["output", "before"],
          ["preview", "--cron", "0 9 * * *"],
        ]) {
          const result = await cli(f.root, [...args, "--json"]);
          expect(result.code).toBe(1);
          expect(result.json()).toMatchObject({
            error: { code: "io_error", message: "Scheduled task storage is unavailable" },
          });
          expect(result.stdout).not.toContain(f.root);
        }
      await agent.close();
      agent = undefined;
      expect((await readdir(directory, { recursive: true })).sort()).toEqual(
        [...original.keys()].sort(),
      );
      for (const [file, bytes] of original)
        if (bytes) expect((await readFile(join(directory, file))).equals(bytes)).toBe(true);
    }
  } finally {
    await agent?.close();
    log.mockRestore();
    await f.close();
  }
}, 15000);

test("historical parameters are read without revalidating execution", async () => {
  const f = await fixture();
  let restored: ScheduledTasks | undefined;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.tasks.create("one", input(f.root), signal);
    await f.tasks.start("one", "shared", signal);
    await finished(f.tasks, "shared");
    await f.tasks.close();
    const value = JSON.parse(await readFile(join(f.root, "tasks", "one.json"), "utf8"));
    value.runs[0].parameters.cwd = "historical display only";
    value.runs[0].parameters.schedule.expression = "not an executable cron";
    const path = join(f.root, "tasks", "one.json");
    await writeFile(path, JSON.stringify(value));
    restored = new ScheduledTasks(f.config);
    await restored.load();
    expect(restored.status().ready).toBe(true);
    expect(restored.run("shared").parameters).toMatchObject({
      cwd: "historical display only",
      schedule: { expression: "not an executable cron" },
    });
    expect(await readFile(join(f.root, "tasks", "shared.stdout"), "utf8")).toBe("你好");
    await restored.close();
    value.runs[0].parameters.schedule = { kind: "once", at: "not an executable date" };
    await writeFile(path, JSON.stringify(value));
    restored = new ScheduledTasks(f.config);
    await restored.load();
    expect(restored.run("shared").parameters.schedule).toEqual(value.runs[0].parameters.schedule);
    await expect(
      restored.update(
        "one",
        restored.get("one").revision,
        {
          schedule: value.runs[0].parameters.schedule,
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await restored.close();
  } finally {
    await restored?.close();
    log.mockRestore();
    await f.close();
  }
});

test("an unchanged missing cwd remains editable and a failed starting write never spawns", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "cwd");
    await mkdir(cwd);
    await f.tasks.create("task", input(cwd), signal);
    await rm(cwd, { recursive: true });
    await f.tasks.update("task", 1, { name: "Changed", cwd }, signal);
    await f.tasks.update("task", 2, { cwd: f.root, command: "printf ran > marker" }, signal);
    const path = join(f.root, "tasks", "task.json"),
      saved = path + ".saved";
    await rename(path, saved);
    await mkdir(path);
    await expect(f.tasks.start("task", "failed-write", signal)).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(f.tasks.runs("task").total).toBe(0);
    expect(f.tasks.status().active).toBe(0);
    await expect(readFile(join(f.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(path, { recursive: true });
    await rename(saved, path);
    await f.tasks.start("task", "after-repair", signal);
    expect((await finished(f.tasks, "after-repair")).state).toBe("succeeded");
  } finally {
    await f.close();
  }
});

test.each(["starting", "running"] as const)(
  "write failure after %s retains the real owner and known terminal facts",
  async (phase) => {
    const f = await fixture({ taskRunsPerDevice: 1 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.tasks.create(
        "task",
        input(f.root, phase === "starting" ? "sleep 60" : "sleep .15; printf done"),
        signal,
      );
      await f.tasks.create("other", input(f.root), signal);
      const path = join(f.root, "tasks", "task.json"),
        saved = path + ".saved";
      let broken = false;
      f.tasks.onChange = (snapshot) => {
        if (
          !broken &&
          snapshot.items.find((task) => task.id === "task")?.currentRun?.state === phase
        ) {
          broken = true;
          renameSync(path, saved);
          mkdirSync(path);
        }
      };
      if (phase === "starting") {
        await expect(f.tasks.start("task", "run", signal)).rejects.toMatchObject({
          outcome: "unknown",
          result: { runId: "run" },
        });
        expect(f.tasks.run("run").pid).toBeGreaterThan(0);
        await expect(f.tasks.stop("run", signal)).rejects.toMatchObject({ outcome: "unknown" });
      } else await f.tasks.start("task", "run", signal);
      expect((await finished(f.tasks, "run")).state).toBe(
        phase === "starting" ? "stopped" : "succeeded",
      );
      await expect.poll(() => f.tasks.status().active).toBe(0);
      expect(f.tasks.status().storageError).toContain("not persisted");
      await f.tasks.start("other", "other-run", signal);
      expect((await finished(f.tasks, "other-run")).state).toBe("succeeded");
      await rm(path, { recursive: true });
      await rename(saved, path);
      await f.tasks.setPaused("task", true, signal);
      const stored = JSON.parse(await readFile(path, "utf8"));
      expect(stored.runs[0].state).toBe(phase === "starting" ? "stopped" : "succeeded");
      expect(stored.runs[0].pid).toBeGreaterThan(0);
      expect(f.tasks.status().storageError).toBeUndefined();
    } finally {
      log.mockRestore();
      await f.close();
    }
  },
);

test("retention failures do not erase completed results or release residual output identities", async () => {
  const f = await fixture({ taskHistoryRuns: 1 });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.tasks.create("task", input(f.root), signal);
    await f.tasks.start("task", "first", signal);
    await finished(f.tasks, "first");
    const path = join(f.root, "tasks", "first.stdout");
    await rename(path, path + ".saved");
    await mkdir(path);
    await f.tasks.start("task", "second", signal);
    expect((await finished(f.tasks, "second")).state).toBe("succeeded");
    await f.tasks.create("other", input(f.root), signal);
    await expect(f.tasks.start("other", "first", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.tasks.start("other", "FIRST", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    await f.tasks.start("other", "third", signal);
    expect((await finished(f.tasks, "third")).state).toBe("succeeded");
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await f.tasks.start("other", "cleanup", signal);
    await finished(f.tasks, "cleanup");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    log.mockRestore();
    await f.close();
  }
});

test.each([false, true])(
  "abnormal owner exit (paused=%s) requires review and stays paused after acknowledgement",
  async (paused) => {
    const f = await fixture({ taskRunsPerDevice: 1, taskHistoryRuns: 1 });
    let child;
    let group: number | undefined;
    const module = pathToFileURL(resolve("agent/dist/tasks/index.js")).href;
    try {
      const script = `import {ScheduledTasks} from ${JSON.stringify(module)};
      const tasks=new ScheduledTasks(${JSON.stringify(f.config)}); await tasks.load();
      await tasks.create('crash',${JSON.stringify(input(f.root, "sleep 60"))},new AbortController().signal);
      await tasks.setPaused('crash',${paused},new AbortController().signal);
      const run=await tasks.start('crash','unknown',new AbortController().signal); console.log(JSON.stringify(run));`;
      child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [data] = await once(child.stdout, "data");
      const run = JSON.parse(data.toString()) as TaskRun;
      group = run.pid;
      child.kill("SIGKILL");
      await once(child, "close");
      await f.tasks.load();
      expect(f.tasks.get("crash")).toMatchObject({ state: "paused", reviewRunId: "unknown" });
      expect(f.tasks.run("unknown").state).toBe("unknown");
      await expect(f.tasks.start("crash", "blocked", signal)).rejects.toMatchObject({
        code: "busy",
      });
      await expect(f.tasks.setPaused("crash", false, signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(f.tasks.delete("crash", undefined, signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(f.tasks.acknowledge("crash", "wrong", signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await f.tasks.create("other", input(f.root), signal);
      await expect(f.tasks.start("other", "capacity", signal)).rejects.toMatchObject({
        code: "busy",
      });
      await f.tasks.update(
        "crash",
        f.tasks.get("crash").revision,
        { command: "printf after-review" },
        signal,
      );
      expect(f.tasks.run("unknown").state).toBe("unknown");
      if (group) {
        process.kill(-group, "SIGKILL");
        group = undefined;
      }
      const checked = await f.tasks.acknowledge("crash", "unknown", signal);
      expect(checked.state).toBe("paused");
      expect(checked.reviewRunId).toBeUndefined();
      await f.tasks.setPaused("crash", false, signal);
      await expect(f.tasks.acknowledge("crash", "unknown", signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(f.tasks.delete("crash", "unknown", signal)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(f.tasks.get("crash").state).toBe("active");
      await f.tasks.start("crash", "after-review", signal);
      expect((await finished(f.tasks, "after-review")).state).toBe("succeeded");
      await f.tasks.delete("crash", undefined, signal);
      expect(f.tasks.list().total).toBe(1);
    } finally {
      child?.kill("SIGKILL");
      if (group) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      await f.close();
    }
  },
  10000,
);

test("state write failure does not prevent normal shutdown stopping real commands", async () => {
  const f = await fixture();
  try {
    await f.tasks.create("active", input(f.root, "sleep 60"), signal);
    const run = await f.tasks.start("active", "running", signal);
    await rename(join(f.root, "tasks"), join(f.root, "saved"));
    await writeFile(join(f.root, "tasks"), "not a directory");
    await expect(f.tasks.setPaused("active", true, signal)).rejects.toThrow();
    await expect(f.tasks.start("active", "blocked", signal)).rejects.toMatchObject({
      code: "busy",
    });
    await expect(f.tasks.close()).rejects.toMatchObject({ code: "io_error" });
    expect(() => process.kill(run.pid!, 0)).toThrow();
    expect(f.tasks.status().active).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

async function cli(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve("agent/dist/main.js"), "schedule", ...args], {
    env: { ...process.env, KITELINE_AGENT_HOME: root, KITELINE_AGENT_RUN_DIR: join(root, "run") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

test("offline CLI help, usage and socket management share the same task and execution identities", async () => {
  const f = await fixture();
  await mkdir(f.config.runDir);
  const local = new LocalServer(f.config, async (method, params, requestSignal) =>
    scheduleRpc(f.tasks, method as ScheduleMethod, params, requestSignal),
  );
  try {
    const help = await cli("/path/that/does/not/exist", ["create", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--acknowledge-run");
    expect((await cli(f.root, ["create", "--json"])).code).toBe(2);
    expect((await cli(f.root, ["list", "--json"])).code).toBe(1);
    await local.start();
    const created = await cli(f.root, [
      "create",
      "--task-id",
      "cli",
      "--name",
      "CLI",
      "--command",
      "printf '你好'",
      "--cron",
      "0 9 * * *",
      "--cwd",
      f.root,
      "--json",
    ]);
    expect(created.code).toBe(0);
    const task = created.json().result as ScheduledTask;
    expect(task.id).toBe("cli");
    expect(
      (
        await cli(f.root, [
          "update",
          task.id,
          "--name",
          "Invalid",
          "--expected-revision",
          "0",
          "--json",
        ])
      ).code,
    ).toBe(2);
    expect((await cli(f.root, ["update", task.id, "--name", "Updated", "--json"])).code).toBe(0);
    expect((await cli(f.root, ["pause", task.id, "--json"])).code).toBe(0);
    const accepted = await cli(f.root, ["run", task.id, "--run-id", "cli-run", "--json"]);
    expect(accepted.code).toBe(0);
    await finished(f.tasks, "cli-run");
    expect((await cli(f.root, ["output", "cli-run", "--stream", "banana", "--json"])).code).toBe(2);
    expect((await cli(f.root, ["output", "cli-run", "--limit", "0", "--json"])).code).toBe(2);
    expect((await cli(f.root, ["status", "cli-run", "--json"])).json().result.state).toBe(
      "succeeded",
    );
    expect((await cli(f.root, ["output", "cli-run", "--json"])).json().result.text).toBe("你好");
    expect((await cli(f.root, ["delete", task.id, "--json"])).code).toBe(2);
    expect((await cli(f.root, ["delete", task.id, "--yes", "--json"])).code).toBe(0);
  } finally {
    await local.close();
    await f.close();
  }
});

test("CLI reports a lost mutation confirmation as unknown with its pre-generated IDs", async () => {
  const f = await fixture();
  await mkdir(f.config.runDir);
  const server = createServer((request) => {
    request.resume();
    request.on("end", () => request.socket.destroy());
  });
  server.listen(join(f.config.runDir, "agent.sock"));
  await once(server, "listening");
  try {
    const result = await cli(f.root, ["run", "task", "--run-id", "lost", "--json"]);
    expect(result.code).toBe(3);
    expect(result.json()).toMatchObject({ outcome: "unknown", taskId: "task", runId: "lost" });
  } finally {
    server.close();
    await f.close();
  }
});
