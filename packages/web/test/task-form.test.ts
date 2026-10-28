import { assert, expect, test } from "vitest";
import type { ScheduledTask, ScheduledTaskInput, TaskSchedule } from "@kiteline/shared/protocol";
import {
  formSchedule,
  localDateTime,
  scheduleForm,
  sameSchedule,
  taskChanges,
  taskTextSize,
  taskTime,
} from "../src/tasks/form";

test.each([
  ["a".repeat(256), "x".repeat(16384), 256, 16384, false, false],
  ["a".repeat(257), "x".repeat(16385), 257, 16385, true, true],
  ["界".repeat(85) + "a", "x", 256, 1, false, false],
  ["界".repeat(86), "x", 258, 1, true, false],
  ["😀".repeat(64), "x".repeat(16385), 256, 16385, false, true],
  [" e\u0301 ", " \n😀\n ", 5, 8, false, false],
])(
  "task text counts raw UTF-8 bytes at the field limits (%#)",
  (name, command, nameBytes, commandBytes, nameTooLong, commandTooLong) => {
    expect(taskTextSize(name, command)).toEqual({
      nameBytes,
      commandBytes,
      nameTooLong,
      commandTooLong,
    });
  },
);

test("editing an elapsed one-time task preserves its original timestamp and consumption", () => {
  const task: ScheduledTask = {
    id: "t",
    revision: 2,
    name: "Old",
    command: "printf old",
    cwd: "/home/project",
    timezone: "UTC",
    schedule: { kind: "once", at: "2025-01-01T09:00:17.123Z" },
    state: "active",
    nextRunAt: null,
    onceStatus: "consumed",
  };
  const initial = scheduleForm(task.schedule);
  const schedule = formSchedule(initial, task.schedule, initial.once);
  assert(schedule);
  expect(taskChanges(task, { ...task, name: "New", schedule })).toEqual({ name: "New" });
  const returned = formSchedule(
    { ...scheduleForm(task.schedule), time: "17:30", cron: "0 * * * *" },
    task.schedule,
    initial.once,
  );
  assert(returned);
  expect(taskChanges(task, { ...task, name: "New", schedule: returned })).toEqual({ name: "New" });
  const changed = formSchedule(
    { ...scheduleForm(task.schedule), once: localDateTime("2030-01-01T12:00:00Z") },
    task.schedule,
    initial.once,
  );
  expect(changed).toEqual({ kind: "once", at: "2030-01-01T12:00:00.000Z" });
});

test("task changes submit changed input fields and omit unchanged or undefined values", () => {
  const task: ScheduledTask = {
    id: "task",
    revision: 1,
    name: "Original",
    command: "printf old",
    cwd: "/home/original",
    timezone: "UTC",
    schedule: { kind: "cron", expression: "0 9 * * *" },
    state: "active",
    nextRunAt: null,
  };
  const changes: Partial<ScheduledTaskInput>[] = [
    { name: "Changed" },
    { command: "printf new" },
    { cwd: "/home/changed" },
    { timezone: "Asia/Tokyo" },
    { schedule: { kind: "cron", expression: "30 12 * * *" } },
  ];
  for (const change of changes) expect(taskChanges(task, { ...task, ...change })).toEqual(change);
  expect(taskChanges(task, { ...task, schedule: { ...task.schedule } })).toEqual({});
  expect(taskChanges(task, { ...task, cwd: undefined, timezone: undefined })).toEqual({});
});

test("an unchanged one-time input survives a browser time-zone change and preset round trip", () => {
  const previous = process.env.TZ;
  const original = { kind: "once" as const, at: "2025-01-01T09:00:17.123Z" };
  process.env.TZ = "America/New_York";
  const initial = scheduleForm(original);
  try {
    process.env.TZ = "Asia/Tokyo";
    expect(formSchedule(initial, original, initial.once)).toBe(original);
    const daily = { ...initial, preset: "daily" as const, time: "12:00" };
    expect(formSchedule(daily, original, initial.once)).toEqual({
      kind: "cron",
      expression: "0 12 * * *",
    });
    expect(formSchedule({ ...daily, preset: "once" }, original, initial.once)).toBe(original);
    expect(formSchedule({ ...initial, once: "2030-01-01T12:00" }, original, initial.once)).toEqual({
      kind: "once",
      at: "2030-01-01T03:00:00.000Z",
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("task instants use browser-local time and show invalid dates as unavailable", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    expect(taskTime("2030-01-01T12:00:00Z", "en-US")).toMatch(/7:00:00\sAM GMT-5/);
    expect(taskTime("2030-01-01T12:00:00Z", "zh-CN")).toMatch(/^2030\/1\/1\s+7:00:00 GMT-5$/);
    expect(taskTime("not a date", "en-US")).toBe("Time unavailable");
    expect(taskTime("2030-01-01T12:00:00Z", "en-US")).toMatch(/7:00:00\sAM GMT-5/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("common presets use one cron and local dates reject missing DST wall time", () => {
  for (const expression of ["0 * * * *", "5 9 * * *", "30 18 * * 0", "*/10 * * * 1-5"])
    expect(formSchedule(scheduleForm({ kind: "cron", expression }))).toEqual({
      kind: "cron",
      expression,
    });
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const form = { ...scheduleForm(), preset: "once" as const, once: "2027-03-14T02:30" };
    expect(formSchedule(form)).toBeNull();
    expect(formSchedule({ ...form, once: "2027-03-14T03:30" })).toEqual({
      kind: "once",
      at: "2027-03-14T07:30:00.000Z",
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test.each(["", "not a date", "2027-02-30T12:00"])(
  "unavailable local one-time input returns null (%j)",
  (once) => {
    expect(formSchedule({ ...scheduleForm(), preset: "once", once })).toBeNull();
  },
);

test("schedule changes compare members independently of property order", () => {
  const task: ScheduledTask = {
    id: "task",
    revision: 1,
    name: "Original",
    command: "printf old",
    cwd: "/home/original",
    timezone: "UTC",
    schedule: { kind: "cron", expression: "0 9 * * *" },
    state: "active",
    nextRunAt: null,
  };
  const cron: TaskSchedule = { kind: "cron", expression: "0 9 * * *" };
  const once: TaskSchedule = { kind: "once", at: "2030-01-01T09:00:17.123Z" };
  const cases: { before: TaskSchedule; reordered: TaskSchedule; changed: TaskSchedule }[] = [
    {
      before: cron,
      reordered: { expression: cron.expression, kind: "cron" },
      changed: { kind: "cron", expression: "30 9 * * *" },
    },
    {
      before: once,
      reordered: { at: once.at, kind: "once" },
      changed: { kind: "once", at: "2030-01-01T09:00:17.124Z" },
    },
  ];
  for (const { before, reordered, changed } of cases) {
    expect(sameSchedule(before, reordered)).toBe(true);
    expect(taskChanges({ ...task, schedule: before }, { ...task, schedule: reordered })).toEqual(
      {},
    );
    expect(sameSchedule(before, changed)).toBe(false);
    expect(taskChanges({ ...task, schedule: before }, { ...task, schedule: changed })).toEqual({
      schedule: changed,
    });
  }
  expect(sameSchedule(cron, once)).toBe(false);
  expect(sameSchedule(once, cron)).toBe(false);
});
