import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, renameSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
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
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  OperationError,
  errorReply,
  limits,
  taskRunActive,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskRun,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";
import { ptyBridgeBinary } from "@kiteline/shared/terminal/node";
import { privateDirectory } from "../src/config.js";
import { taskLimits } from "../src/limits.js";
import { testConfig } from "./support/config.js";
import { ScheduledTasks } from "../src/tasks/index.js";
import { checkSchedule, checkTimezone, nextOccurrence } from "../src/tasks/schedule.js";
import { scheduleMethods, scheduleRpc, type ScheduleMethod } from "../src/tasks/rpc.js";
import { LocalServer } from "../src/local.js";
import { Agent } from "../src/agent.js";
import { localRequest } from "../src/local.js";
import { diagnose, type DoctorReport } from "../src/doctor.js";

const signal = new AbortController().signal;
// Linux limits each argv/env string to 32 pages; x64/arm64 pages are at most 64 KiB.
const oversizedLinuxEnvironmentBytes = 64 * 1024 * 32 + 1;
const input = (cwd: string, command = "printf '你好'; printf error >&2") => ({
  name: "Daily",
  command,
  cwd,
  timezone: "UTC",
  schedule: { kind: "cron", expression: "0 9 * * *" },
});

async function fixture(limits = {}, onChange: (snapshot: TaskSnapshot) => void = () => {}) {
  const root = await mkdtemp("/var/tmp/kiteline-schedule-test-");
  const config = testConfig(root, { shell: "/bin/bash", limits });
  const tasks = new ScheduledTasks(config, onChange);
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
  await expect.poll(() => taskRunActive(tasks.getRun(id).state), { timeout }).toBe(false);
  return tasks.getRun(id);
}

function interceptOutputWrites(
  paths: string[],
  intercept: (file: FileHandle, path: string) => void,
) {
  const open = fs.open;
  const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (typeof args[0] === "string" && paths.includes(args[0]) && args[1] === "wx")
      intercept(file, args[0]);
    return file;
  });
  syncBuiltinESMExports();
  return () => {
    opening.mockRestore();
    syncBuiltinESMExports();
  };
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
    expect(() => f.tasks.getRun("reviewrun")).toThrow("does not exist");
    await f.tasks.close();
    restored = new ScheduledTasks(f.config, () => {});
    await restored.load();
    expect(restored.get("ReviewTask").id).toBe("ReviewTask");
    expect(restored.getRun("ReviewRun").taskId).toBe("ReviewTask");
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
    expect(f.tasks.listRuns(task.id).total).toBe(2);
    expect(() => f.tasks.getRun("first")).toThrow("does not exist or has been cleaned up");
    expect(f.tasks.get(task.id).state).toBe("paused");
    await f.tasks.update(task.id, f.tasks.get(task.id).revision, { command: "true" }, signal);
    for (const id of ["empty-first", "empty-second", "empty-third"]) {
      await f.tasks.start(task.id, id, signal);
      await finished(f.tasks, id);
    }
    expect(f.tasks.listRuns(task.id).total).toBe(2);
    expect(() => f.tasks.getRun("empty-first")).toThrow("does not exist or has been cleaned up");
    expect(f.tasks.getRun("empty-second").output.stdoutBytes).toBe(0);
    await f.tasks.delete(task.id, undefined, signal);
    expect(f.tasks.list().total).toBe(0);
  } finally {
    await f.close();
  }
});

test("RPC updates preserve every input field and runs keep the full acceptance snapshot", async () => {
  const f = await fixture();
  try {
    const originalInput: Required<ScheduledTaskInput> = {
      ...input(f.root, "while [ ! -e release ]; do sleep .02; done; printf old"),
      schedule: { kind: "cron", expression: "0 0 1 1 *" },
      timezone: "America/New_York",
    };
    const task = await f.tasks.create("task", originalInput, signal);
    const originalRun = await f.tasks.start(task.id, "original", signal);
    const cwd = join(f.root, "changed-cwd");
    await mkdir(cwd);
    let expectedInput = originalInput;
    let revision = task.revision;
    const changes: Partial<ScheduledTaskInput>[] = [
      { name: "Changed" },
      { command: "printf new" },
      { cwd },
      { timezone: checkTimezone() === "Asia/Tokyo" ? "Asia/Shanghai" : "Asia/Tokyo" },
      { schedule: { kind: "cron", expression: "30 12 1 1 *" } },
    ];
    for (const change of changes) {
      const updated = await scheduleRpc(
        f.tasks,
        "tasks.update",
        { taskId: task.id, expectedRevision: revision, changes: change },
        signal,
      );
      expectedInput = { ...expectedInput, ...change };
      revision++;
      const current = f.tasks.get(task.id);
      expect(updated).toEqual(current);
      expect(current).toMatchObject({ ...expectedInput, revision });
      const stored = JSON.parse(await readFile(join(f.root, "tasks", "task.json"), "utf8"));
      expect(stored.task).toEqual(JSON.parse(JSON.stringify(current)));
      expect(f.tasks.getRun(originalRun.id)).toMatchObject({
        state: "running",
        acceptedAt: originalRun.acceptedAt,
        parameters: { ...originalInput, taskRevision: task.revision },
      });
    }

    const snapshot = f.tasks.snapshot();
    expect(() =>
      scheduleRpc(
        f.tasks,
        "tasks.update",
        { taskId: task.id, expectedRevision: revision, changes: { state: "paused" } },
        signal,
      ),
    ).toThrow("Unknown task field: state");
    await expect(
      f.tasks.update(task.id, revision, { name: undefined }, signal),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(f.tasks.snapshot()).toEqual(snapshot);
    expect(f.tasks.get(task.id)).toMatchObject({ ...expectedInput, revision });

    const reset = await f.tasks.update(task.id, revision, { timezone: undefined }, signal);
    expectedInput = { ...expectedInput, timezone: checkTimezone() };
    revision++;
    expect(reset).toMatchObject({ ...expectedInput, revision });
    await writeFile(join(f.root, "release"), "");
    const originalResult = await finished(f.tasks, originalRun.id);
    expect(originalResult.parameters).toEqual({ ...originalInput, taskRevision: task.revision });
    expect(originalResult.acceptedAt).toBe(originalRun.acceptedAt);
    expect((await f.tasks.output(originalRun.id, "stdout", 0, 32, signal)).text).toBe("old");
    const next = await f.tasks.start(task.id, "updated", signal);
    expect(next.parameters).toEqual({ ...expectedInput, taskRevision: revision });
    expect((await finished(f.tasks, next.id)).state).toBe("succeeded");
    expect((await f.tasks.output(next.id, "stdout", 0, 32, signal)).text).toBe("new");
  } finally {
    await f.close();
  }
});

test("cancellation rejects a queued start but does not undo a published starting run", async () => {
  const accepted = new AbortController();
  const queued = new AbortController();
  const cancellation = new Error("Cancelled before task admission");
  const f = await fixture({}, (snapshot) => {
    if (snapshot.items.find((task) => task.id === "accepted")?.currentRun?.state === "starting") {
      accepted.abort();
      queued.abort(cancellation);
    }
  });
  try {
    await f.tasks.create("accepted", input(f.root, "printf accepted > accepted.marker"), signal);
    await f.tasks.create("queued", input(f.root, "printf queued > queued.marker"), signal);

    const starting = f.tasks.start("accepted", "accepted-run", accepted.signal);
    const rejected = expect(f.tasks.start("queued", "queued-run", queued.signal)).rejects.toBe(
      cancellation,
    );
    await starting;
    await rejected;
    expect(accepted.signal.aborted).toBe(true);
    expect((await finished(f.tasks, "accepted-run")).state).toBe("succeeded");
    expect(await readFile(join(f.root, "accepted.marker"), "utf8")).toBe("accepted");
    expect(f.tasks.listRuns("queued").total).toBe(0);
    await expect(readFile(join(f.root, "queued.marker"))).rejects.toMatchObject({ code: "ENOENT" });
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
    reloaded = new ScheduledTasks(f.config, () => {});
    await reloaded.load();
    expect(reloaded.getRun("wide-run")).toMatchObject({
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
  const f = await fixture({ taskRunsPerDevice: 1 });
  try {
    const at = new Date(Date.now() + 500).toISOString();
    const task = await f.tasks.create(
      "once",
      { ...input(f.root, "sleep 1; printf done"), schedule: { kind: "once", at } },
      signal,
    );
    await f.tasks.start(task.id, "manual", signal);
    await expect.poll(() => f.tasks.get(task.id).onceStatus).toBe("consumed");
    expect(f.tasks.listRuns(task.id).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "skipped", reasonCode: "overlap" }),
      ]),
    );
    await finished(f.tasks, "manual");
    await f.tasks.close();
    const restored = new ScheduledTasks(f.config, () => {});
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

test("scheduled capacity skips consume the occurrence without starting a command", async () => {
  const f = await fixture({ taskRunsPerDevice: 1 });
  try {
    await f.tasks.create("active", input(f.root, "sleep 60"), signal);
    await f.tasks.start("active", "occupied", signal);
    const at = new Date(Date.now() + 250).toISOString();
    await f.tasks.create(
      "scheduled",
      { ...input(f.root, "printf ran > capacity.marker"), schedule: { kind: "once", at } },
      signal,
    );
    await expect.poll(() => f.tasks.get("scheduled").onceStatus).toBe("consumed");
    expect(f.tasks.listRuns("scheduled").items).toMatchObject([
      { state: "skipped", reasonCode: "capacity", scheduledAt: at },
    ]);
    expect(f.tasks.get("scheduled").nextRunAt).toBeNull();
    await expect(readFile(join(f.root, "capacity.marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.close();
  }
});

test("scheduled lateness takes precedence over overlap and capacity", async () => {
  const f = await fixture({ taskRunsPerDevice: 1 });
  try {
    const at = new Date(Date.now() + 250).toISOString();
    await f.tasks.create(
      "late",
      { ...input(f.root, "sleep 60"), schedule: { kind: "once", at } },
      signal,
    );
    await f.tasks.start("late", "manual", signal);
    // Let the real occurrence expire while its callback cannot enter the event loop.
    while (Date.now() <= Date.parse(at) + taskLimits.lateToleranceMs) {
      /* Intentional event-loop stall. */
    }
    await expect.poll(() => f.tasks.get("late").onceStatus).toBe("missed");
    expect(f.tasks.listRuns("late").items).toContainEqual(
      expect.objectContaining({ state: "skipped", reasonCode: "missed", scheduledAt: at }),
    );
    expect(f.tasks.getRun("manual").state).toBe("running");
  } finally {
    await f.close();
  }
}, 10000);

test.each(["before starting", "after starting"] as const)(
  "one-shot admission write failure %s preserves the processed occurrence",
  async (phase) => {
    let blocked = false;
    const published: TaskSnapshot[] = [];
    const f = await fixture({}, (snapshot) => {
      published.push(snapshot);
      if (
        phase === "after starting" &&
        !blocked &&
        snapshot.items[0]?.currentRun?.state === "starting"
      ) {
        renameSync(path, saved);
        mkdirSync(path);
        blocked = true;
      }
    });
    const path = join(f.root, "tasks", "scheduled.json");
    const saved = path + ".saved";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const at = new Date(Date.now() + 300).toISOString();
      await f.tasks.create(
        "scheduled",
        { ...input(f.root, "printf done > scheduled.marker"), schedule: { kind: "once", at } },
        signal,
      );
      if (phase === "before starting") {
        renameSync(path, saved);
        mkdirSync(path);
        blocked = true;
      }
      const onceStatus = phase === "before starting" ? "missed" : "consumed";
      await expect.poll(() => f.tasks.get("scheduled").onceStatus).toBe(onceStatus);
      const run = f.tasks.listRuns("scheduled").items[0]!;
      const result = await finished(f.tasks, run.id);
      await expect.poll(() => f.tasks.status().active).toBe(0);
      expect(f.tasks.listRuns("scheduled").total).toBe(1);
      expect(f.tasks.get("scheduled").nextRunAt).toBeNull();
      expect(result).toMatchObject({ trigger: "scheduled", scheduledAt: at });
      expect(f.tasks.status().failures).toContainEqual(
        expect.stringContaining("scheduled not persisted"),
      );
      expect(f.tasks.snapshot()).toEqual(published.at(-1));
      if (phase === "before starting") {
        expect(result).toMatchObject({ state: "skipped", reasonCode: "missed" });
        expect(published.some((snapshot) => snapshot.items[0]?.currentRun)).toBe(false);
        await expect(readFile(join(f.root, "scheduled.marker"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(result).toMatchObject({ state: "succeeded", exitCode: 0 });
        expect(await readFile(join(f.root, "scheduled.marker"), "utf8")).toBe("done");
      }
      await rm(path, { recursive: true });
      await rename(saved, path);
      blocked = false;
      await f.tasks.setPaused("scheduled", true, signal);
      const stored = JSON.parse(await readFile(path, "utf8"));
      expect(stored).toMatchObject({ lastScheduledAt: at, task: { onceStatus, nextRunAt: null } });
      expect(stored.runs).toEqual([JSON.parse(JSON.stringify(result))]);
      expect(f.tasks.status().failures).toEqual([]);
    } finally {
      if (blocked) {
        await rm(path, { recursive: true });
        await rename(saved, path);
      }
      await f.close();
      log.mockRestore();
    }
  },
);

test("failed cron admission advances to the next occurrence without inventing a run", async () => {
  const f = await fixture();
  const path = join(f.root, "tasks", "cron.json");
  const saved = path + ".saved";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let blocked = false;
  try {
    const task = await f.tasks.create(
      "cron",
      {
        ...input(f.root, "printf ran > cron.marker"),
        schedule: { kind: "cron", expression: "* * * * *" },
      },
      signal,
    );
    renameSync(path, saved);
    mkdirSync(path);
    blocked = true;
    await expect
      .poll(() => f.tasks.get("cron").nextRunAt, { timeout: 62000 })
      .not.toBe(task.nextRunAt);
    expect(Date.parse(f.tasks.get("cron").nextRunAt!)).toBeGreaterThan(Date.parse(task.nextRunAt!));
    expect(f.tasks.listRuns("cron").total).toBe(0);
    expect(f.tasks.status().failures).toContainEqual(expect.stringContaining("cron not persisted"));
    await expect(readFile(join(f.root, "cron.marker"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(path, { recursive: true });
    await rename(saved, path);
    blocked = false;
    const nextRunAt = f.tasks.get("cron").nextRunAt;
    await f.tasks.update("cron", task.revision, { name: "Repaired" }, signal);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      lastScheduledAt: task.nextRunAt,
      task: { nextRunAt },
      runs: [],
    });
    expect(f.tasks.status().failures).toEqual([]);
  } finally {
    if (blocked) {
      await rm(path, { recursive: true });
      await rename(saved, path);
    }
    await f.close();
    log.mockRestore();
  }
}, 65000);

test("a failed overlap write retains consumed once status and skipped history after repair", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const at = new Date(Date.now() + 1000).toISOString();
    await f.tasks.create(
      "task",
      { ...input(f.root, "sleep 60"), schedule: { kind: "once", at } },
      signal,
    );
    await f.tasks.start("task", "manual", signal);
    const path = join(f.root, "tasks", "task.json");
    await rename(path, path + ".saved");
    await mkdir(path);
    await expect
      .poll(() => f.tasks.status().failures, { timeout: 3000 })
      .toContainEqual(expect.stringContaining("not persisted"));
    expect(f.tasks.get("task").onceStatus).toBe("consumed");
    const skipped = { state: "skipped", reasonCode: "overlap", scheduledAt: at };
    expect(f.tasks.listRuns("task").items).toContainEqual(expect.objectContaining(skipped));
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await f.tasks.setPaused("task", true, signal);
    expect(f.tasks.status().failures).toEqual([]);
    await f.tasks.close();
    const restored = new ScheduledTasks(f.config, () => {});
    try {
      await restored.load();
      expect(restored.get("task")).toMatchObject({ onceStatus: "consumed", nextRunAt: null });
      expect(restored.listRuns("task").items).toContainEqual(expect.objectContaining(skipped));
    } finally {
      await restored.close();
    }
  } finally {
    log.mockRestore();
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
      expect(f.tasks.listRuns("paused")).toMatchObject({
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
    expect(f.tasks.listRuns("due").items).toEqual(
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
    expect(() => f.tasks.getRun("large")).toThrow();
  } finally {
    await f.close();
  }
});

test("pending writes across streams and runs share both output budgets", async () => {
  const runBudget = 64;
  const totalBudget = 96;
  const streamOutput = "a".repeat(48);
  const f = await fixture({ taskOutputBytes: runBudget, taskOutputTotalBytes: totalBudget });
  const paths = ["stdout", "stderr"].map((stream) => join(f.root, "tasks", `first.${stream}`));
  const entered = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = interceptOutputWrites(paths, (file, path) => {
    const write = file.write.bind(file);
    file.write = (async (
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      entered.add(path);
      await gate;
      return write(buffer, offset, length, position);
    }) as FileHandle["write"];
  });
  try {
    await f.tasks.create(
      "first",
      input(
        f.root,
        `printf '${streamOutput}'; printf '${streamOutput}' >&2; while [ ! -e release-first ]; do sleep .01; done`,
      ),
      signal,
    );
    await f.tasks.create(
      "second",
      input(f.root, `printf '${streamOutput}'; printf '${streamOutput}' >&2`),
      signal,
    );
    await f.tasks.start("first", "first", signal);
    await expect.poll(() => entered.size).toBe(paths.length);
    for (const path of paths) expect((await readFile(path)).length).toBe(0);
    const pending = f.tasks.getRun("first");
    expect(pending.output.stdoutBytes + pending.output.stderrBytes).toBe(runBudget);
    await f.tasks.start("second", "second", signal);
    const second = await finished(f.tasks, "second");
    expect(second.output.stdoutBytes + second.output.stderrBytes).toBe(totalBudget - runBudget);
    expect(second.output.truncated).toBe(true);
    expect(f.tasks.getRun("first").state).toBe("running");

    release();
    await writeFile(join(f.root, "release-first"), "");
    const first = await finished(f.tasks, "first");
    expect(first.output.stdoutBytes + first.output.stderrBytes).toBe(runBudget);
    expect(first.output.truncated).toBe(true);
    let stored = 0;
    for (const run of [first, second]) {
      expect(run.state).toBe("succeeded");
      expect(run.output.error).toBeUndefined();
      for (const stream of ["stdout", "stderr"] as const) {
        const bytes = (await readFile(join(f.root, "tasks", `${run.id}.${stream}`))).length;
        expect(bytes).toBe(run.output[stream === "stdout" ? "stdoutBytes" : "stderrBytes"]);
        stored += bytes;
      }
    }
    expect(stored).toBe(totalBudget);
  } finally {
    release();
    restore();
    await f.close();
  }
});

test("a failed short write releases only unwritten bytes for another active run", async () => {
  const runBudget = 64;
  const writtenBytes = 24;
  const firstOutput = "a".repeat(runBudget);
  const secondOutput = "b".repeat(runBudget);
  const f = await fixture({ taskOutputBytes: runBudget, taskOutputTotalBytes: runBudget });
  const path = join(f.root, "tasks", "short.stdout");
  const failure = new Error("Task output write failed after its prefix");
  let prefixWritten = false;
  const restore = interceptOutputWrites([path], (file) => {
    const write = file.write.bind(file);
    file.write = (async (
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (prefixWritten) throw failure;
      prefixWritten = true;
      return write(buffer, offset, Math.min(length, writtenBytes), position);
    }) as FileHandle["write"];
  });
  try {
    await f.tasks.create(
      "first",
      input(f.root, `printf '${firstOutput}'; while [ ! -e release-first ]; do sleep .01; done`),
      signal,
    );
    await f.tasks.create("second", input(f.root, `printf '${secondOutput}'`), signal);
    await f.tasks.start("first", "short", signal);
    await expect.poll(() => f.tasks.getRun("short").output.error).toBe(failure.message);
    expect(f.tasks.getRun("short")).toMatchObject({
      state: "running",
      output: { stdoutBytes: writtenBytes, stderrBytes: 0, truncated: false },
    });
    expect(await readFile(path, "utf8")).toBe(firstOutput.slice(0, writtenBytes));

    await f.tasks.start("second", "remaining", signal);
    const remaining = runBudget - writtenBytes;
    expect(await finished(f.tasks, "remaining")).toMatchObject({
      state: "succeeded",
      output: { stdoutBytes: remaining, stderrBytes: 0, truncated: true },
    });
    expect(await readFile(join(f.root, "tasks", "remaining.stdout"), "utf8")).toBe(
      secondOutput.slice(0, remaining),
    );
    expect(f.tasks.getRun("short").state).toBe("running");
    await writeFile(join(f.root, "release-first"), "");
    expect(await finished(f.tasks, "short")).toMatchObject({
      state: "succeeded",
      output: { stdoutBytes: writtenBytes, truncated: false, error: failure.message },
    });
  } finally {
    restore();
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
    expect(f.tasks.getRun("running").state).toBe("stopping");
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
    expect(taskRunActive(f.tasks.getRun(run.id).state)).toBe(true);
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

test.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))(
  "synchronous spawn failure publishes its state with the revision and prunes before returning",
  async () => {
    const previousEnvironment = process.env.KITELINE_TASK_TEST_OVERSIZED_ENV;
    let settled = false;
    let sampling: Promise<void> | undefined;
    let startingRevision: number | undefined;
    const notifications: TaskSnapshot[] = [];
    const observations: {
      revision: number;
      runState: TaskRun["state"];
      summaryState: TaskRun["state"] | undefined;
      listedState: TaskRun["state"] | undefined;
    }[] = [];
    const f = await fixture({ taskHistoryRuns: 1 }, (snapshot) => {
      notifications.push(snapshot);
      if (snapshot.items[0]?.currentRun?.id !== "rejected") return;
      startingRevision = snapshot.revision;
      sampling = (async () => {
        while (!settled) {
          await setImmediate();
          const current = f.tasks.snapshot();
          observations.push({
            revision: current.revision,
            runState: f.tasks.getRun("rejected").state,
            summaryState: current.items[0]?.latestRun?.state,
            listedState: f.tasks.listRuns("task").items[0]?.state,
          });
        }
      })();
    });
    try {
      const parameters = input(f.root);
      const task = await f.tasks.create("task", parameters, signal);
      await f.tasks.start(task.id, "first", signal);
      expect((await finished(f.tasks, "first")).state).toBe("succeeded");
      await expect.poll(() => f.tasks.status().active).toBe(0);
      const path = join(f.root, "tasks", "task.json");
      expect(JSON.parse(await readFile(path, "utf8")).runs).toHaveLength(1);
      expect(await readFile(join(f.root, "tasks", "first.stdout"), "utf8")).toBe("你好");
      expect(await readFile(join(f.root, "tasks", "first.stderr"), "utf8")).toBe("error");

      process.env.KITELINE_TASK_TEST_OVERSIZED_ENV = "x".repeat(oversizedLinuxEnvironmentBytes);
      const result = await f.tasks.start(task.id, "rejected", signal).finally(() => {
        settled = true;
      });
      await sampling;

      expect(result).toMatchObject({
        state: "failed",
        reasonCode: "start_failed",
        exitCode: null,
        diagnostic: expect.stringContaining("E2BIG"),
        parameters: { ...parameters, taskRevision: task.revision },
        output: { stdoutBytes: 0, stderrBytes: 0, truncated: false },
      });
      expect(result.startedAt).toBeUndefined();
      expect(result.pid).toBeUndefined();
      expect(f.tasks.status().active).toBe(0);
      expect(f.tasks.get(task.id).revision).toBe(task.revision);
      expect(startingRevision).toBeDefined();
      const unpublished = observations.filter((read) => read.revision === startingRevision);
      expect(unpublished.length).toBeGreaterThan(0);
      expect
        .soft(
          new Set(
            unpublished.flatMap((read) => [read.runState, read.summaryState, read.listedState]),
          ),
          "Public reads must stay starting until the failed revision is published",
        )
        .toEqual(new Set(["starting"]));
      const failedNotification = notifications.find(
        (snapshot) => snapshot.items[0]?.latestRun?.state === "failed",
      );
      expect(failedNotification?.revision).toBeGreaterThan(startingRevision!);
      expect(f.tasks.snapshot()).toEqual(notifications.at(-1));
      expect(f.tasks.getRun(result.id)).toEqual(result);
      expect.soft(f.tasks.listRuns(task.id).items.map((run) => run.id)).toEqual([result.id]);
      const stored = JSON.parse(await readFile(path, "utf8"));
      expect.soft(stored.runs.map((run: TaskRun) => run.id)).toEqual([result.id]);
      const files = await readdir(join(f.root, "tasks"));
      for (const stream of ["stdout", "stderr"] as const) {
        expect.soft(files).not.toContain(`first.${stream}`);
        expect(files).not.toContain(`rejected.${stream}`);
        expect(await f.tasks.output(result.id, stream, 0, 32, signal)).toMatchObject({
          text: "",
          storedBytes: 0,
          finished: true,
        });
      }
    } finally {
      if (previousEnvironment === undefined) delete process.env.KITELINE_TASK_TEST_OVERSIZED_ENV;
      else process.env.KITELINE_TASK_TEST_OVERSIZED_ENV = previousEnvironment;
      settled = true;
      await sampling;
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))(
  "synchronous spawn failure stays known when saving facts and pruning history both fail",
  async () => {
    const previousEnvironment = process.env.KITELINE_TASK_TEST_OVERSIZED_ENV;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let startingRevision: number | undefined;
    const notifications: TaskSnapshot[] = [];
    const f = await fixture({ taskHistoryRuns: 1 }, (snapshot) => {
      notifications.push(snapshot);
      if (snapshot.items[0]?.currentRun?.id !== "rejected") return;
      startingRevision = snapshot.revision;
      renameSync(path, saved);
      blocked = true;
      mkdirSync(path);
    });
    const path = join(f.root, "tasks", "task.json");
    const saved = path + ".saved";
    let blocked = false;
    try {
      await f.tasks.create("task", input(f.root), signal);
      await f.tasks.start("task", "first", signal);
      expect((await finished(f.tasks, "first")).state).toBe("succeeded");
      await expect.poll(() => f.tasks.status().active).toBe(0);
      process.env.KITELINE_TASK_TEST_OVERSIZED_ENV = "x".repeat(oversizedLinuxEnvironmentBytes);
      const result = await f.tasks.start("task", "rejected", signal);
      expect(result).toMatchObject({
        state: "failed",
        reasonCode: "start_failed",
        exitCode: null,
        diagnostic: expect.stringContaining("E2BIG"),
      });
      expect(result.startedAt).toBeUndefined();
      expect(result.pid).toBeUndefined();
      expect(f.tasks.status().active).toBe(0);
      expect(f.tasks.getRun(result.id)).toEqual(result);
      expect(startingRevision).toBeDefined();
      expect(f.tasks.snapshot().revision).toBeGreaterThan(startingRevision!);
      expect(f.tasks.snapshot()).toEqual(notifications.at(-1));
      expect(f.tasks.snapshot().items[0]?.latestRun?.state).toBe("failed");
      expect(f.tasks.status().failures).toContainEqual(
        expect.stringContaining("task not persisted"),
      );
      expect
        .soft(f.tasks.status().failures)
        .toContainEqual(expect.stringContaining("task retention failed"));
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("facts"),
        "task",
        expect.stringContaining("EISDIR"),
      );

      expect(f.tasks.listRuns("task").items.map((run) => run.id)).toEqual(["rejected", "first"]);
      expect(JSON.parse(await readFile(saved, "utf8")).runs.at(-1)).toMatchObject({
        id: "rejected",
        state: "starting",
      });

      await rm(path, { recursive: true });
      await rename(saved, path);
      blocked = false;
      await f.tasks.setPaused("task", true, signal);
      expect(f.tasks.listRuns("task").items.map((run) => run.id)).toEqual([result.id]);
      expect(JSON.parse(await readFile(path, "utf8")).runs).toEqual([result]);
      expect.soft(f.tasks.status().failures).toEqual([]);
    } finally {
      if (previousEnvironment === undefined) delete process.env.KITELINE_TASK_TEST_OVERSIZED_ENV;
      else process.env.KITELINE_TASK_TEST_OVERSIZED_ENV = previousEnvironment;
      try {
        if (blocked) {
          await rm(path, { recursive: true });
          await rename(saved, path);
        }
      } finally {
        log.mockRestore();
        await f.close();
      }
    }
  },
);

test("stop queued by the terminal notification cannot change a completed run back to stopping", async () => {
  let stopped: Promise<TaskRun> | undefined;
  const f = await fixture({}, (snapshot) => {
    if (snapshot.items[0]?.latestRun?.state === "succeeded")
      stopped ??= f.tasks.stop("run", signal);
  });
  try {
    await f.tasks.create("task", input(f.root), signal);

    await f.tasks.start("task", "run", signal);
    await expect.poll(() => stopped).toBeDefined();
    expect(await stopped).toMatchObject({ state: "succeeded", exitCode: 0 });
    expect(f.tasks.getRun("run").state).toBe("succeeded");
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
    expect(f.tasks.getRun("one").output.truncated).toBe(false);
    await f.tasks.close();
    await truncate(join(f.root, "tasks", "one.stdout"), 32);
    const emptyOrphans = ["stdout", "stderr"].map((stream) =>
      join(f.root, "tasks", `empty-orphan.${stream}`),
    );
    for (const path of emptyOrphans) await writeFile(path, "");
    const shortened = new ScheduledTasks(f.config, () => {});
    try {
      await shortened.load();
      for (const path of emptyOrphans)
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(shortened.getRun("one").output).toMatchObject({ stdoutBytes: 32, truncated: true });
      expect(await shortened.output("one", "stdout", 64, 32, signal)).toMatchObject({
        offset: 0,
        nextOffset: 32,
        storedBytes: 32,
        truncated: true,
      });
      await rm(join(f.root, "tasks", "one.stdout"));
      expect(await shortened.output("one", "stdout", 32, 32, signal)).toMatchObject({
        offset: 0,
        nextOffset: 0,
        storedBytes: 0,
        text: "",
        truncated: true,
      });
      await writeFile(join(f.root, "tasks", "one.stdout"), Buffer.alloc(32));
    } finally {
      await shortened.close();
    }
    const smaller = new ScheduledTasks(
      { ...f.config, limits: { ...f.config.limits, taskOutputBytes: 16, taskOutputTotalBytes: 8 } },
      () => {},
    );
    try {
      await smaller.load();
      expect(smaller.listRuns("limits").total).toBe(1);
      expect(smaller.getRun("one").output).toMatchObject({ stdoutBytes: 32, truncated: true });
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
    restored = new ScheduledTasks(
      { ...f.config, limits: { ...f.config.limits, tasksPerDevice: 1 } },
      () => {},
    );
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
    expect(f.tasks.getRun("old")).toEqual(old);
    expect((await readFile(join(f.root, "tasks", "old.stdout"))).length).toBe(20);
    expect(f.tasks.getRun("running").state).toBe("running");
  } finally {
    await f.close();
  }
});

test.each(["broken JSON", "invalid schedule"])(
  "%s disables every task RPC before any startup write while the real agent stays usable",
  async (failure) => {
    const f = await fixture();
    let agent: Agent | undefined;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.tasks.create("good", input(f.root), signal);
      await f.tasks.create("invalid", input(f.root), signal);
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
      const path = join(f.root, "tasks", "invalid.json");
      if (failure === "broken JSON") await writeFile(path, "{");
      else {
        const invalid = JSON.parse(await readFile(path, "utf8"));
        invalid.task.schedule = { kind: "cron", expression: "invalid" };
        await writeFile(path, JSON.stringify(invalid));
      }
      await writeFile(join(f.root, "tasks", "unclaimed.stdout"), "Do not delete");
      await writeFile(join(f.root, "tasks", "empty-orphan.stderr"), "");
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
        for (const path of [agent.config.dataDir, agent.config.runDir])
          await privateDirectory(path);
        await agent.start();
        expect(await localRequest(f.config, "workspaces.list")).toEqual({ workspaces: [] });
        for (const method of scheduleMethods)
          await expect(localRequest(f.config, method)).rejects.toMatchObject({
            code: "io_error",
            message: "Scheduled task storage is unavailable",
            details: undefined,
          });
        expect(agent.schedules.snapshot()).toEqual({ revision: 0, storageError: true, items: [] });
        expect(agent.schedules.status().loadError).toContain(`${path}:`);
        expect(agent.schedules.status().failures).toEqual([]);
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
  },
  15000,
);

test("output scan failures identify the output path and leave startup files unchanged", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let restored: ScheduledTasks | undefined;
  try {
    await f.tasks.create("task", input(f.root), signal);
    await f.tasks.close();
    const directory = join(f.root, "tasks");
    const statePath = join(directory, "task.json");
    const before = await readFile(statePath, "utf8");
    const outputPath = join(directory, "invalid.stdout");
    await mkdir(outputPath);
    const temporaryPath = join(directory, "unpublished.tmp");
    await writeFile(temporaryPath, "unpublished");
    restored = new ScheduledTasks(f.config, () => {});
    await restored.load();
    expect(restored.status().loadError).toBe(`${outputPath}: Output is not a regular file`);
    expect(restored.status().failures).toEqual([]);
    expect(restored.snapshot()).toEqual({ revision: 0, storageError: true, items: [] });
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(await readFile(temporaryPath, "utf8")).toBe("unpublished");
    expect((await lstat(outputPath)).isDirectory()).toBe(true);
  } finally {
    await restored?.close();
    log.mockRestore();
    await f.close();
  }
});

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
    restored = new ScheduledTasks(f.config, () => {});
    await restored.load();
    expect(restored.status().loadError).toBeUndefined();
    expect(restored.getRun("shared").parameters).toMatchObject({
      cwd: "historical display only",
      schedule: { expression: "not an executable cron" },
    });
    expect(await readFile(join(f.root, "tasks", "shared.stdout"), "utf8")).toBe("你好");
    await restored.close();
    value.runs[0].parameters.schedule = { kind: "once", at: "not an executable date" };
    await writeFile(path, JSON.stringify(value));
    restored = new ScheduledTasks(f.config, () => {});
    await restored.load();
    expect(restored.getRun("shared").parameters.schedule).toEqual(
      value.runs[0].parameters.schedule,
    );
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

test("a stored lossy cwd rejects updates even when only another field changes", async () => {
  const f = await fixture();
  let restored: ScheduledTasks | undefined;
  try {
    const task = await f.tasks.create("task", input(f.root), signal);
    await f.tasks.close();
    const path = join(f.root, "tasks", "task.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    value.task.cwd = join(f.root, "cwd-\uD800");
    await writeFile(path, JSON.stringify(value));
    restored = new ScheduledTasks(f.config, () => {});
    await restored.load();
    const stored = await readFile(path, "utf8");

    await expect(
      restored.update(task.id, task.revision, { name: "Changed" }, signal),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(restored.get(task.id)).toMatchObject({
      name: task.name,
      cwd: value.task.cwd,
      revision: task.revision,
    });
    expect(await readFile(path, "utf8")).toBe(stored);
  } finally {
    await restored?.close();
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
    expect(f.tasks.listRuns("task").total).toBe(0);
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
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = false;
    const f = await fixture({ taskRunsPerDevice: 1 }, (snapshot) => {
      if (
        !broken &&
        snapshot.items.find((task) => task.id === "task")?.currentRun?.state === phase
      ) {
        broken = true;
        renameSync(path, saved);
        mkdirSync(path);
      }
    });
    const path = join(f.root, "tasks", "task.json"),
      saved = path + ".saved";
    try {
      await f.tasks.create(
        "task",
        input(f.root, phase === "starting" ? "sleep 60" : "sleep .15; printf done"),
        signal,
      );
      await f.tasks.create("other", input(f.root), signal);
      if (phase === "starting") {
        await expect(f.tasks.start("task", "run", signal)).rejects.toMatchObject({
          outcome: "unknown",
          result: { taskId: "task", runId: "run" },
        });
        expect(f.tasks.getRun("run").pid).toBeGreaterThan(0);
        await expect(f.tasks.stop("run", signal)).rejects.toMatchObject({ outcome: "unknown" });
      } else await f.tasks.start("task", "run", signal);
      expect((await finished(f.tasks, "run")).state).toBe(
        phase === "starting" ? "stopped" : "succeeded",
      );
      await expect.poll(() => f.tasks.status().active).toBe(0);
      expect(f.tasks.status().failures).toContainEqual(expect.stringContaining("not persisted"));
      await f.tasks.start("other", "other-run", signal);
      expect((await finished(f.tasks, "other-run")).state).toBe("succeeded");
      expect(f.tasks.status().failures).toContainEqual(
        expect.stringContaining("task not persisted"),
      );
      await rm(path, { recursive: true });
      await rename(saved, path);
      await f.tasks.setPaused("task", true, signal);
      const stored = JSON.parse(await readFile(path, "utf8"));
      expect(stored.runs[0].state).toBe(phase === "starting" ? "stopped" : "succeeded");
      expect(stored.runs[0].pid).toBeGreaterThan(0);
      expect(f.tasks.status().failures).toEqual([]);
    } finally {
      log.mockRestore();
      await f.close();
    }
  },
);

test("cross-task save failures stay with the reclaimed task until it is saved or deleted", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let observeSave = false;
  let savedStatus: ReturnType<ScheduledTasks["status"]> | undefined;
  const f = await fixture(
    { taskHistoryRuns: 10, taskOutputBytes: 64, taskOutputTotalBytes: 64 },
    () => {
      if (observeSave) savedStatus = f.tasks.status();
    },
  );
  const path = join(f.root, "tasks", "old.json");
  const saved = path + ".saved";
  const retentionFailure = expect.stringMatching(/^old retention failed: .*EISDIR/);
  let blocked = false;
  try {
    await f.tasks.create("old", input(f.root, `printf '${"x".repeat(64)}'`), signal);
    await f.tasks.create("manual", input(f.root, "printf ran > manual.marker"), signal);
    await f.tasks.start("old", "old-run", signal);
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect(f.tasks.getRun("old-run").output.stdoutBytes).toBe(64);
    await rename(path, saved);
    await mkdir(path);
    blocked = true;
    for (const id of ["attempt-one", "attempt-two"]) {
      await expect(f.tasks.start("manual", id, signal)).rejects.toMatchObject({ code: "EISDIR" });
      expect(f.tasks.status()).toMatchObject({
        loadError: undefined,
        failures: [retentionFailure],
      });
    }
    expect(f.tasks.listRuns("old").total).toBe(1);
    expect(f.tasks.listRuns("manual").total).toBe(0);
    await expect(readFile(join(f.root, "manual.marker"))).rejects.toMatchObject({ code: "ENOENT" });

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const at = new Date(Date.now() + 1000).toISOString();
    await f.tasks.create(
      "scheduled",
      {
        ...input(f.root, "printf ran > scheduled.marker"),
        schedule: { kind: "once", at },
      },
      signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await f.tasks.setPaused("manual", true, signal);
    expect(f.tasks.listRuns("scheduled").items).toMatchObject([
      { state: "skipped", reasonCode: "missed", scheduledAt: at },
    ]);
    await expect(readFile(join(f.root, "scheduled.marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.tasks.status().failures).toEqual([retentionFailure]);
    vi.useRealTimers();

    const report = await diagnose(f.config, signal, {
      server: "http://127.0.0.1:1",
      connected: false,
      revision: 0,
      shell: f.config.shell,
      sessions: [],
      schedules: f.tasks.status(),
    });
    expect(report.items.find((item) => item.name === "Scheduled Tasks")).toMatchObject({
      status: "error",
      detail: expect.stringContaining("ready=true;"),
    });
    expect(report.items.find((item) => item.name === "Scheduled Tasks")?.detail).toContain(
      "old retention failed:",
    );

    await rm(path, { recursive: true });
    await rename(saved, path);
    blocked = false;
    observeSave = true;
    await f.tasks.setPaused("old", true, signal);
    observeSave = false;
    expect(savedStatus).toMatchObject({ loadError: undefined, failures: [] });
    expect(f.tasks.listRuns("old").total).toBe(1);
    expect(f.tasks.status().failures).toEqual([]);

    await rename(path, saved);
    await mkdir(path);
    blocked = true;
    await expect(f.tasks.start("manual", "before-delete", signal)).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(f.tasks.delete("old", undefined, signal)).rejects.toMatchObject({
      code: "ERR_FS_EISDIR",
    });
    expect(f.tasks.status().failures).toEqual([retentionFailure]);
    await rm(path, { recursive: true });
    await rename(saved, path);
    blocked = false;
    await expect(f.tasks.delete("old", undefined, signal)).resolves.toEqual({ removed: true });
    expect(f.tasks.status().failures).toEqual([]);
    await expect(readFile(join(f.root, "tasks", "old-run.stdout"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    vi.useRealTimers();
    if (blocked) {
      await rm(path, { recursive: true });
      await rename(saved, path);
    }
    log.mockRestore();
    await f.close();
  }
});

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
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect(f.tasks.listRuns("task").items.map((run) => run.id)).toEqual(["second"]);
    expect
      .soft(f.tasks.status().failures)
      .toContainEqual(expect.stringContaining("first output cleanup failed"));
    expect
      .soft(f.tasks.status().failures)
      .not.toContainEqual(expect.stringContaining("retention failed"));
    await f.tasks.create("other", input(f.root), signal);
    await expect(f.tasks.start("other", "first", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.tasks.start("other", "FIRST", signal)).rejects.toMatchObject({
      code: "conflict",
    });
    await f.tasks.start("other", "third", signal);
    expect((await finished(f.tasks, "third")).state).toBe("succeeded");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect
      .soft(f.tasks.status().failures)
      .toContainEqual(expect.stringContaining("first output cleanup failed"));
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await f.tasks.start("other", "cleanup", signal);
    await finished(f.tasks, "cleanup");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.tasks.status().failures).toEqual([]);
  } finally {
    log.mockRestore();
    await f.close();
  }
});

test("output cleanup failure is reported only by run while task history remains over its limit", async () => {
  const f = await fixture({ taskHistoryRuns: 3 });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let restored: ScheduledTasks | undefined;
  let blocked = false;
  const path = join(f.root, "tasks", "first.stdout");
  try {
    await f.tasks.create("task", input(f.root), signal);
    for (const id of ["first", "second", "third"]) {
      await f.tasks.start("task", id, signal);
      await finished(f.tasks, id);
      await expect.poll(() => f.tasks.status().active).toBe(0);
    }
    await f.tasks.close();
    restored = new ScheduledTasks(
      { ...f.config, limits: { ...f.config.limits, taskHistoryRuns: 1 } },
      () => {
        if (blocked) return;
        renameSync(path, path + ".saved");
        mkdirSync(path);
        blocked = true;
      },
    );
    await restored.load();
    expect(restored.listRuns("task").items.map((run) => run.id)).toEqual(["third", "second"]);
    expect(restored.status()).toMatchObject({
      loadError: undefined,
      failures: [expect.stringContaining("first output cleanup failed:")],
    });
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await restored.setPaused("task", true, signal);
    expect(restored.listRuns("task").items.map((run) => run.id)).toEqual(["third"]);
    expect(restored.status().failures).toEqual([
      expect.stringContaining("first output cleanup failed:"),
    ]);
    await restored.start("task", "after-repair", signal);
    await finished(restored, "after-repair");
    await expect.poll(() => restored!.status().active).toBe(0);
    expect(restored.status().failures).toEqual([]);
  } finally {
    await restored?.close();
    log.mockRestore();
    await f.close();
  }
});

test("retention save failures belong to the task until its next successful save", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let injectFailure = true;
  let blocked = false;
  let terminalStatus: ReturnType<ScheduledTasks["status"]> | undefined;
  const f = await fixture({ taskHistoryRuns: 1 }, () => {
    const runs = f.tasks.listRuns("task").items;
    if (!injectFailure || blocked || runs.length !== 2 || runs[0]?.state !== "succeeded") return;
    terminalStatus = f.tasks.status();
    renameSync(path, saved);
    mkdirSync(path);
    blocked = true;
  });
  const path = join(f.root, "tasks", "task.json");
  const saved = path + ".saved";
  try {
    await f.tasks.create("task", input(f.root), signal);
    await f.tasks.create("other", input(f.root), signal);
    await f.tasks.start("task", "first", signal);
    await finished(f.tasks, "first");
    await expect.poll(() => f.tasks.status().active).toBe(0);

    await f.tasks.start("task", "second", signal);
    await finished(f.tasks, "second");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect(terminalStatus).toMatchObject({ loadError: undefined, failures: [] });
    expect(f.tasks.status().failures).toContainEqual(
      expect.stringContaining("task retention failed"),
    );
    expect(f.tasks.status().failures).toContainEqual(expect.stringContaining("EISDIR"));
    expect(f.tasks.status().failures).not.toContainEqual(expect.stringContaining("not persisted"));

    await f.tasks.start("other", "other-run", signal);
    await finished(f.tasks, "other-run");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect
      .soft(f.tasks.status().failures)
      .toContainEqual(expect.stringContaining("task retention failed"));
    await expect(f.tasks.start("task", "blocked", signal)).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect
      .soft(f.tasks.status().failures)
      .toContainEqual(expect.stringContaining("task retention failed"));
    expect(f.tasks.listRuns("task").total).toBe(2);

    injectFailure = false;
    await rm(path, { recursive: true });
    await rename(saved, path);
    blocked = false;
    await f.tasks.setPaused("task", true, signal);
    expect(f.tasks.listRuns("task").items.map((run) => run.id)).toEqual(["second"]);
    expect(f.tasks.status().failures).toEqual([]);
    await expect(readFile(join(f.root, "tasks", "first.stdout"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    injectFailure = false;
    if (blocked) {
      await rm(path, { recursive: true });
      await rename(saved, path);
    }
    log.mockRestore();
    await f.close();
  }
});

test("cross-task reclamation clears the saved task failure before later terminal publication", async () => {
  const oldOutput = "o".repeat(32);
  const activeOutput = "a".repeat(16);
  const runOutputBudget = Buffer.byteLength(oldOutput);

  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let blocked = false;
  const terminalObservations: {
    runs: string[];
    status: ReturnType<ScheduledTasks["status"]>;
  }[] = [];
  let injectFailure = true;
  let observeTerminal = false;
  let reclamationStatus: ReturnType<ScheduledTasks["status"]> | undefined;
  const f = await fixture(
    {
      taskHistoryRuns: 1,
      taskOutputBytes: runOutputBudget,
      taskOutputTotalBytes: runOutputBudget * 2,
    },
    () => {
      const runs = f.tasks.listRuns("task").items;
      if (injectFailure && !blocked && runs.some((run) => run.reasonCode === "overlap")) {
        renameSync(path, saved);
        mkdirSync(path);
        blocked = true;
      }
      if (!injectFailure && !reclamationStatus && !runs.some((run) => run.id === "old"))
        reclamationStatus = f.tasks.status();
      if (observeTerminal && runs.find((run) => run.id === "active")?.state === "succeeded")
        terminalObservations.push({ runs: runs.map((run) => run.id), status: f.tasks.status() });
    },
  );
  const path = join(f.root, "tasks", "task.json");
  const saved = path + ".saved";
  try {
    await f.tasks.create("task", input(f.root, `printf '${oldOutput}'`), signal);
    await f.tasks.create("other", input(f.root, "true"), signal);
    await f.tasks.start("task", "old", signal);
    await finished(f.tasks, "old");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    await f.tasks.update(
      "task",
      f.tasks.get("task").revision,
      { command: `printf '${activeOutput}'; while [ ! -f release ]; do sleep .02; done` },
      signal,
    );
    await f.tasks.start("task", "active", signal);
    await expect
      .poll(() => f.tasks.getRun("active").output.stdoutBytes)
      .toBe(Buffer.byteLength(activeOutput));

    await f.tasks.update(
      "task",
      f.tasks.get("task").revision,
      { schedule: { kind: "once", at: new Date(Date.now() + 250).toISOString() } },
      signal,
    );
    await expect
      .poll(() => f.tasks.status().failures)
      .toContainEqual(expect.stringContaining("EISDIR"));
    expect(f.tasks.status().failures).not.toContainEqual(expect.stringContaining("not persisted"));
    expect(f.tasks.listRuns("task").total).toBe(3);
    injectFailure = false;
    await rm(path, { recursive: true });
    await rename(saved, path);
    blocked = false;

    // The old 32 bytes plus active 16 bytes leave less than the 32-byte admission budget.
    await f.tasks.start("other", "new", signal);
    await finished(f.tasks, "new");
    expect(f.tasks.listRuns("task").items.map((run) => run.id)).not.toContain("old");
    await expect(readFile(join(f.root, "tasks", "old.stdout"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.tasks.status().failures).toEqual([]);
    expect(reclamationStatus).toMatchObject({ loadError: undefined, failures: [] });
    observeTerminal = true;
    await writeFile(join(f.root, "release"), "");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect(terminalObservations).toHaveLength(1);
    expect(terminalObservations[0]!.runs).toHaveLength(2);
    expect(terminalObservations[0]!.status).toMatchObject({
      loadError: undefined,
      failures: [],
    });
    expect(f.tasks.listRuns("task").items).toMatchObject([{ reasonCode: "overlap" }]);
  } finally {
    injectFailure = false;
    observeTerminal = false;
    if (blocked) {
      await rm(path, { recursive: true });
      await rename(saved, path);
    }
    log.mockRestore();
    await f.close();
  }
});

test("partial task deletion diagnoses only failed outputs and reserves every unremoved run ID", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.tasks.create("task", input(f.root), signal);
    await f.tasks.create("other", input(f.root, "true"), signal);
    for (const id of ["First", "Second"]) {
      await f.tasks.start("task", id, signal);
      await finished(f.tasks, id);
      await expect.poll(() => f.tasks.status().active).toBe(0);
    }
    const path = join(f.root, "tasks", "First.stdout");
    await rename(path, path + ".saved");
    await mkdir(path);
    await expect(f.tasks.delete("task", undefined, signal)).rejects.toMatchObject({
      outcome: "partial",
      result: { removed: true },
    });
    expect(() => f.tasks.get("task")).toThrow("does not exist");
    await expect(readFile(join(f.root, "tasks", "task.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect
      .soft(f.tasks.status().failures)
      .toContainEqual(expect.stringContaining("First output cleanup failed"));
    expect.soft(f.tasks.status().failures).toContainEqual(expect.stringContaining(path));
    expect(f.tasks.status().failures).not.toContainEqual(expect.stringContaining("Second"));
    expect(await readFile(join(f.root, "tasks", "Second.stdout"), "utf8")).toBe("你好");
    for (const id of ["first", "second"])
      await expect(f.tasks.start("other", id, signal)).rejects.toMatchObject({ code: "conflict" });

    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await f.tasks.start("other", "cleanup", signal);
    await finished(f.tasks, "cleanup");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    expect(f.tasks.status().failures).toEqual([]);
    for (const id of ["First", "Second"])
      for (const stream of ["stdout", "stderr"])
        await expect(readFile(join(f.root, "tasks", `${id}.${stream}`))).rejects.toMatchObject({
          code: "ENOENT",
        });
    for (const id of ["first", "second"]) {
      await f.tasks.start("other", id, signal);
      await finished(f.tasks, id);
      await expect.poll(() => f.tasks.status().active).toBe(0);
    }
  } finally {
    log.mockRestore();
    await f.close();
  }
});

test("partial output deletion releases the removed stream before a later retry settles the rest", async () => {
  const runBudget = 64;
  const totalBudget = 96;
  const oldStdout = "a".repeat(24);
  const oldStderr = "b".repeat(40);
  const nextOutput = "c".repeat(runBudget);
  const f = await fixture({ taskOutputBytes: runBudget, taskOutputTotalBytes: totalBudget });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdoutPath = join(f.root, "tasks", "OldRun.stdout");
  const stderrPath = join(f.root, "tasks", "OldRun.stderr");
  try {
    await f.tasks.create(
      "old",
      input(f.root, `printf '${oldStdout}'; printf '${oldStderr}' >&2`),
      signal,
    );
    await f.tasks.create(
      "active",
      input(f.root, `printf '${nextOutput}'; while [ ! -e release-active ]; do sleep .01; done`),
      signal,
    );
    await f.tasks.create("after", input(f.root, `printf '${nextOutput}'`), signal);
    await f.tasks.start("old", "OldRun", signal);
    expect(await finished(f.tasks, "OldRun")).toMatchObject({
      output: { stdoutBytes: oldStdout.length, stderrBytes: oldStderr.length, truncated: false },
    });
    await expect.poll(() => f.tasks.status().active).toBe(0);
    await rename(stderrPath, stderrPath + ".saved");
    await mkdir(stderrPath);
    await expect(f.tasks.delete("old", undefined, signal)).rejects.toMatchObject({
      outcome: "partial",
      result: { removed: true },
    });
    expect(() => f.tasks.get("old")).toThrow("does not exist");
    await expect(readFile(stdoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.tasks.status().failures).toContainEqual(
      expect.stringContaining("OldRun output cleanup failed"),
    );
    expect(f.tasks.status().failures).toContainEqual(expect.stringContaining(stderrPath));
    await expect(f.tasks.start("after", "oldrun", signal)).rejects.toMatchObject({
      code: "conflict",
    });

    await f.tasks.start("active", "during-failure", signal);
    const remainingBeforeRepair = totalBudget - oldStderr.length;
    await expect
      .poll(() => readFile(join(f.root, "tasks", "during-failure.stdout"), "utf8"))
      .toBe(nextOutput.slice(0, remainingBeforeRepair));
    expect(f.tasks.getRun("during-failure").output).toMatchObject({
      stdoutBytes: remainingBeforeRepair,
      stderrBytes: 0,
      truncated: true,
    });
    expect(f.tasks.status().failures).toContainEqual(
      expect.stringContaining("OldRun output cleanup failed"),
    );

    await rm(stderrPath, { recursive: true });
    await rename(stderrPath + ".saved", stderrPath);
    await f.tasks.start("after", "after-repair", signal);
    const remainingAfterRepair = totalBudget - remainingBeforeRepair;
    expect(await finished(f.tasks, "after-repair")).toMatchObject({
      state: "succeeded",
      output: { stdoutBytes: remainingAfterRepair, stderrBytes: 0, truncated: true },
    });
    expect(await readFile(join(f.root, "tasks", "after-repair.stdout"), "utf8")).toBe(
      nextOutput.slice(0, remainingAfterRepair),
    );
    expect(f.tasks.getRun("during-failure").state).toBe("running");
    for (const path of [stdoutPath, stderrPath])
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.tasks.status().failures).toEqual([]);
    await writeFile(join(f.root, "release-active"), "");
    await finished(f.tasks, "during-failure");
    await expect.poll(() => f.tasks.status().active).toBe(0);
    await f.tasks.start("after", "oldrun", signal);
    expect((await finished(f.tasks, "oldrun")).state).toBe("succeeded");
  } finally {
    log.mockRestore();
    await f.close();
  }
});

test("startup temporary-file cleanup remains diagnosed through IPC and doctor until restart", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let agent: Agent | undefined;
  try {
    await f.tasks.close();
    const directory = join(f.root, "tasks");
    const temporary = join(directory, "unfinished.tmp");
    await mkdir(temporary);
    await writeFile(join(directory, "orphan.stdout"), "orphan");
    await privateDirectory(f.config.runDir);
    const identity = { deviceId: "test", deviceToken: "test", server: "http://127.0.0.1:1" };
    agent = new Agent(f.config, identity);
    await agent.start();
    await expect(readFile(join(directory, "orphan.stdout"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const report = await localRequest<DoctorReport>(f.config, "doctor");
    expect.soft(report.items.find((item) => item.name === "Scheduled Tasks")).toMatchObject({
      status: "error",
      detail: expect.stringContaining("unfinished.tmp startup cleanup failed"),
    });
    expect(report.items.find((item) => item.name === "Scheduled Tasks")?.detail).toContain(
      "ready=true;",
    );
    const failure = await agentCli(f.root, ["doctor"]);
    expect.soft(failure.stdout).toContain("[error] Scheduled Tasks:");
    expect.soft(failure.stdout).toContain("unfinished.tmp startup cleanup failed");
    expect.soft(failure.code).toBe(1);
    await localRequest(f.config, "tasks.create", { taskId: "task", input: input(f.root) });
    await localRequest(f.config, "tasks.run", { taskId: "task", runId: "run" });
    await finished(agent.schedules, "run");
    await expect.poll(() => agent!.schedules.status().active).toBe(0);
    expect(agent.schedules.snapshot().items).toHaveLength(1);
    expect(agent.schedules.snapshot().storageError).toBeUndefined();
    expect
      .soft(agent.schedules.status().failures)
      .toContainEqual(expect.stringContaining("unfinished.tmp"));
    await rm(temporary, { recursive: true });
    expect
      .soft(agent.schedules.status().failures)
      .toContainEqual(expect.stringContaining("unfinished.tmp"));
    await agent.close();

    agent = new Agent(f.config, identity);
    await agent.start();
    const restored = await localRequest<DoctorReport>(f.config, "doctor");
    expect(restored.items.find((item) => item.name === "Scheduled Tasks")).toMatchObject({
      status: "ok",
    });
    expect(restored.items.filter((item) => item.status === "error")).toEqual([]);
    const success = await agentCli(f.root, ["doctor"]);
    expect(success.stdout).toContain("[ok] Scheduled Tasks:");
    expect(success.code).toBe(0);
  } finally {
    await agent?.close();
    log.mockRestore();
    await f.close();
  }
}, 15000);

test.each([false, true])(
  "abnormal owner exit (paused=%s) requires review and stays paused after acknowledgement",
  async (paused) => {
    const f = await fixture({ taskRunsPerDevice: 1, taskHistoryRuns: 1 });
    let child;
    let group: number | undefined;
    let restored: ScheduledTasks | undefined;
    try {
      await f.tasks.close();
      child = spawn(
        process.execPath,
        [
          resolve("packages/agent/test/support/task-crash-child.mjs"),
          JSON.stringify({ config: f.config, input: input(f.root, "sleep 60"), paused }),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const [data] = await once(child.stdout, "data");
      const run = JSON.parse(data.toString()) as TaskRun;
      group = run.pid;
      child.kill("SIGKILL");
      await once(child, "close");
      restored = new ScheduledTasks(f.config, () => {});
      await restored.load();
      expect(restored.get("crash")).toMatchObject({ state: "paused", reviewRunId: "unknown" });
      expect(restored.getRun("unknown").state).toBe("unknown");
      await expect(restored.start("crash", "blocked", signal)).rejects.toMatchObject({
        code: "busy",
      });
      await expect(restored.setPaused("crash", false, signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(restored.delete("crash", undefined, signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(restored.acknowledge("crash", "wrong", signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await restored.create("other", input(f.root), signal);
      await expect(restored.start("other", "capacity", signal)).rejects.toMatchObject({
        code: "busy",
      });
      await restored.update(
        "crash",
        restored.get("crash").revision,
        { command: "printf after-review" },
        signal,
      );
      expect(restored.getRun("unknown").state).toBe("unknown");
      if (group) {
        process.kill(-group, "SIGKILL");
        group = undefined;
      }
      const checked = await restored.acknowledge("crash", "unknown", signal);
      expect(checked.state).toBe("paused");
      expect(checked.reviewRunId).toBeUndefined();
      await restored.setPaused("crash", false, signal);
      await expect(restored.acknowledge("crash", "unknown", signal)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(restored.delete("crash", "unknown", signal)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(restored.get("crash").state).toBe("active");
      await restored.start("crash", "after-review", signal);
      expect((await finished(restored, "after-review")).state).toBe("succeeded");
      await restored.delete("crash", undefined, signal);
      expect(restored.list().total).toBe(1);
    } finally {
      child?.kill("SIGKILL");
      if (group) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      await restored?.close();
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
  return agentCli(root, ["schedule", ...args]);
}

async function agentCli(root: string, args: string[]) {
  const child = spawn(process.execPath, [resolve("packages/agent/dist/main.js"), ...args], {
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

async function deleteInTerminal(root: string, taskId: string, answer: string) {
  const child = spawn(
    ptyBridgeBinary,
    [
      "80",
      "24",
      String(limits.dataChunkBytes),
      String(limits.terminalPendingBytes),
      process.execPath,
      resolve("packages/agent/dist/main.js"),
      "schedule",
      "delete",
      taskId,
      "--json",
    ],
    {
      env: { ...process.env, KITELINE_AGENT_HOME: root, KITELINE_AGENT_RUN_DIR: join(root, "run") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  const closed = once(child, "close");
  try {
    await expect
      .poll(() => output)
      .toContain(`Delete task ${taskId} and its retained results? [y/N]`);
    const payload = Buffer.from(answer + "\r");
    const header = Buffer.alloc(5);
    header.write("I");
    header.writeUInt32BE(payload.length, 1);
    child.stdin.write(Buffer.concat([header, payload]));
    const [code] = await closed;
    expect(diagnostic).toBe("");
    const jsonLine = output.split(/\r?\n/).find((line) => line.startsWith('{"outcome":'));
    expect(jsonLine).toBeDefined();
    return { code, json: JSON.parse(jsonLine!) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
}

test("CLI help and usage precede config while execution errors retain generated IDs", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "config.json"), "{");
    const help = await cli(f.root, ["--help", "--json"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    const commands = help.stdout.split("All commands support")[0]!;
    for (const command of [
      "list",
      "show",
      "create",
      "update",
      "preview",
      "run",
      "pause",
      "resume",
      "acknowledge",
      "runs",
      "status",
      "output",
      "stop",
      "delete",
    ])
      expect(commands).toContain(`kiteline-agent schedule ${command} `);
    expect(help.stdout).toContain("On exit 3 query the printed taskId/runId");

    const usage = await cli(f.root, ["run", "task", "--task-id", "wrong", "--json"]);
    expect(usage.code).toBe(2);
    expect(usage.json()).toEqual({
      outcome: "failed",
      error: { code: "invalid_argument", message: expect.stringContaining("--task-id") },
    });
    const deletion = await cli(f.root, ["delete", "task", "--json"]);
    expect(deletion.code).toBe(2);
    expect(deletion.json()).toEqual({
      outcome: "failed",
      error: {
        code: "invalid_argument",
        message: "Use --yes to confirm deletion without a terminal",
      },
    });
    const confirmed = await cli(f.root, ["delete", "task", "--yes", "--json"]);
    expect(confirmed.code).toBe(1);
    expect(confirmed.json()).toEqual({
      outcome: "failed",
      taskId: "task",
      error: { code: "io_error", message: expect.any(String) },
    });
    const creation = await cli(f.root, [
      "create",
      "--name",
      "CLI",
      "--command",
      "true",
      "--cron",
      "0 9 * * *",
      "--json",
    ]);
    expect(creation.code).toBe(1);
    expect(creation.json()).toEqual({
      outcome: "failed",
      taskId: expect.stringMatching(/^[a-zA-Z0-9_-]+$/),
      error: { code: "io_error", message: expect.any(String) },
    });
    const run = await cli(f.root, ["run", "task", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json()).toEqual({
      outcome: "failed",
      taskId: "task",
      runId: expect.stringMatching(/^[a-zA-Z0-9_-]+$/),
      error: { code: "io_error", message: expect.any(String) },
    });
  } finally {
    await f.close();
  }
});

test("CLI deletion confirms in a real terminal before config and includes IDs only after confirmation", async () => {
  const f = await fixture();
  await mkdir(f.config.runDir);
  const requests: string[] = [];
  const local = new LocalServer(f.config, async (method, params, requestSignal) => {
    requests.push(method);
    return scheduleRpc(f.tasks, method as ScheduleMethod, params, requestSignal);
  });
  try {
    await local.start();
    await f.tasks.create("task", input(f.root), signal);
    await writeFile(join(f.root, "config.json"), "{");
    expect(await deleteInTerminal(f.root, "task", "n")).toEqual({
      code: 1,
      json: { outcome: "failed", error: { code: "cancelled", message: "Deletion cancelled" } },
    });
    expect(requests).toEqual([]);
    expect(await deleteInTerminal(f.root, "task", "y")).toEqual({
      code: 1,
      json: {
        outcome: "failed",
        error: { code: "io_error", message: expect.any(String) },
        taskId: "task",
      },
    });
    expect(requests).toEqual([]);
    await rm(join(f.root, "config.json"));
    expect(await deleteInTerminal(f.root, "task", "y")).toEqual({
      code: 0,
      json: { outcome: "succeeded", result: { removed: true } },
    });
    expect(requests).toEqual(["tasks.delete"]);
    expect(f.tasks.list().total).toBe(0);
  } finally {
    await local.close();
    await f.close();
  }
});

test("offline CLI help, usage and socket management share the same task and execution identities", async () => {
  const f = await fixture();
  await mkdir(f.config.runDir);
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const local = new LocalServer(f.config, async (method, params, requestSignal) => {
    requests.push({ method, params });
    return scheduleRpc(f.tasks, method as ScheduleMethod, params, requestSignal);
  });
  try {
    const help = await cli("/path/that/does/not/exist", ["create", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--acknowledge-run");
    expect((await cli(f.root, ["create", "--json"])).code).toBe(2);
    expect((await cli(f.root, ["list", "--json"])).code).toBe(1);
    await local.start();
    const unknownOption = await cli(f.root, ["run", "task", "--task-id", "other", "--json"]);
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.json()).toEqual({
      outcome: "failed",
      error: { code: "invalid_argument", message: expect.stringContaining("--task-id") },
    });
    expect(requests).toEqual([]);
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
      "--timezone",
      "Etc/UTC",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const task = created.json().result as ScheduledTask;
    expect(task.id).toBe("cli");
    expect(requests.at(-1)).toEqual({
      method: "tasks.create",
      params: {
        taskId: "cli",
        input: {
          name: "CLI",
          command: "printf '你好'",
          schedule: { kind: "cron", expression: "0 9 * * *" },
          cwd: f.root,
          timezone: "Etc/UTC",
        },
      },
    });
    const beforeMissing = requests.length;
    const missing = await cli(f.root, ["update", "missing", "--name", "Missing", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.json()).toMatchObject({
      outcome: "failed",
      error: { code: "not_found" },
      taskId: "missing",
    });
    expect(requests.slice(beforeMissing)).toEqual([
      { method: "tasks.get", params: { taskId: "missing" } },
    ]);
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
    expect(requests.at(-1)).toEqual({
      method: "tasks.update",
      params: { taskId: task.id, expectedRevision: 0, changes: { name: "Invalid" } },
    });
    expect((await cli(f.root, ["update", task.id, "--name", "Updated", "--json"])).code).toBe(0);
    expect(requests.slice(-2)).toEqual([
      { method: "tasks.get", params: { taskId: task.id } },
      {
        method: "tasks.update",
        params: { taskId: task.id, expectedRevision: task.revision, changes: { name: "Updated" } },
      },
    ]);
    const beforeExplicit = requests.length;
    const explicit = await cli(f.root, [
      "update",
      task.id,
      "--name",
      "Explicit",
      "--expected-revision",
      String(task.revision + 1),
      "--json",
    ]);
    expect(explicit.code).toBe(0);
    expect(requests.slice(beforeExplicit)).toEqual([
      {
        method: "tasks.update",
        params: {
          taskId: task.id,
          expectedRevision: task.revision + 1,
          changes: { name: "Explicit" },
        },
      },
    ]);
    expect((await cli(f.root, ["pause", task.id, "--json"])).code).toBe(0);
    const accepted = await cli(f.root, ["run", task.id, "--run-id", "cli-run", "--json"]);
    expect(accepted.code).toBe(0);
    await finished(f.tasks, "cli-run");
    expect((await cli(f.root, ["output", "cli-run", "--stream", "banana", "--json"])).code).toBe(2);
    expect(requests.at(-1)).toEqual({
      method: "runs.output",
      params: { runId: "cli-run", stream: "banana", offset: 0 },
    });
    expect((await cli(f.root, ["output", "cli-run", "--limit", "0", "--json"])).code).toBe(2);
    expect(requests.at(-1)).toEqual({
      method: "runs.output",
      params: { runId: "cli-run", stream: "stdout", offset: 0, limit: 0 },
    });
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

test("CLI can query actual create and run mutations after losing confirmation with generated IDs", async () => {
  const f = await fixture();
  await mkdir(f.config.runDir);
  const requests: { method: ScheduleMethod; params: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
      requests.push(body);
      const result = await scheduleRpc(f.tasks, body.method, body.params, signal);
      if (body.method === "tasks.create" || body.method === "tasks.run") request.socket.destroy();
      else response.end(JSON.stringify({ id: "local", outcome: "succeeded", result }));
    } catch (error) {
      response.end(JSON.stringify(errorReply("local", error)));
    }
  });
  server.listen(join(f.config.runDir, "agent.sock"));
  await once(server, "listening");
  try {
    const created = await cli(f.root, [
      "create",
      "--name",
      "Lost confirmation",
      "--command",
      "printf recovered",
      "--cron",
      "0 9 * * *",
      "--cwd",
      f.root,
      "--json",
    ]);
    expect(created.code).toBe(3);
    expect(created.json()).toMatchObject({ outcome: "unknown", taskId: expect.any(String) });
    const taskId = created.json().taskId as string;
    expect(requests.find((request) => request.method === "tasks.create")?.params.taskId).toBe(
      taskId,
    );
    const shown = await cli(f.root, ["show", taskId, "--json"]);
    expect(shown.code).toBe(0);
    expect(shown.json()).toMatchObject({
      outcome: "succeeded",
      result: { id: taskId, name: "Lost confirmation" },
    });

    const run = await cli(f.root, ["run", taskId, "--json"]);
    expect(run.code).toBe(3);
    expect(run.json()).toMatchObject({ outcome: "unknown", taskId, runId: expect.any(String) });
    const runId = run.json().runId as string;
    expect(requests.find((request) => request.method === "tasks.run")?.params).toEqual({
      taskId,
      runId,
    });
    await finished(f.tasks, runId);
    const status = await cli(f.root, ["status", runId, "--json"]);
    expect(status.code).toBe(0);
    expect(status.json()).toMatchObject({
      outcome: "succeeded",
      result: { id: runId, taskId, state: "succeeded" },
    });
    expect((await cli(f.root, ["output", runId, "--json"])).json().result.text).toBe("recovered");
    expect(requests.map((request) => request.method)).toEqual([
      "tasks.create",
      "tasks.get",
      "tasks.run",
      "runs.get",
      "runs.output",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test("CLI preserves local error results and details with schedule-specific exit precedence", async () => {
  const f = await fixture();
  await mkdir(f.config.runDir);
  const local = new LocalServer(f.config, async (_method, params) => {
    const unknown = params.runId === "unknown";
    throw new OperationError(
      unknown ? "invalid_argument" : "io_error",
      "Reported operation failure",
      unknown ? "unknown" : "partial",
      { runId: params.runId },
      { reason: "retained diagnostic" },
    );
  });
  try {
    await local.start();
    for (const { runId, outcome, code, exit } of [
      { runId: "partial", outcome: "partial", code: "io_error", exit: 1 },
      { runId: "unknown", outcome: "unknown", code: "invalid_argument", exit: 3 },
    ] as const) {
      const result = await cli(f.root, ["stop", runId, "--json"]);
      expect(result.code).toBe(exit);
      expect(result.json()).toEqual({
        outcome,
        error: {
          code,
          message: "Reported operation failure",
          details: { reason: "retained diagnostic" },
        },
        runId,
        result: { runId },
      });
      expect(result.stderr).toBe(`${code}: Reported operation failure (runId=${runId})\n`);
    }
    const plain = await cli(f.root, ["stop", "partial"]);
    expect(plain).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "io_error: Reported operation failure (runId=partial)\n",
    });
  } finally {
    await local.close();
    await f.close();
  }
});
