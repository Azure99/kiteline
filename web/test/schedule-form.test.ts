import { expect, test } from "vitest";
import type { ScheduledTask } from "@kiteline/shared/protocol";
import { formSchedule, localDateTime, scheduleForm, taskChanges } from "../src/schedules/form";

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
  const schedule = formSchedule(scheduleForm(task.schedule), task.schedule);
  expect(taskChanges(task, { ...task, name: "New", schedule })).toEqual({ name: "New" });
  const returned = formSchedule(
    { ...scheduleForm(task.schedule), time: "17:30", cron: "0 * * * *" },
    task.schedule,
  );
  expect(taskChanges(task, { ...task, name: "New", schedule: returned })).toEqual({ name: "New" });
  const changed = formSchedule(
    { ...scheduleForm(task.schedule), once: localDateTime("2030-01-01T12:00:00Z") },
    task.schedule,
  );
  expect(changed).toEqual({ kind: "once", at: "2030-01-01T12:00:00.000Z" });
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
    expect(() => formSchedule(form)).toThrow("existing local date");
    expect(formSchedule({ ...form, once: "2027-03-14T03:30" })).toEqual({
      kind: "once",
      at: "2027-03-14T07:30:00.000Z",
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
