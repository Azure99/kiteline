import {
  taskInputKeys,
  taskTextLimits,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskSchedule,
} from "@kiteline/shared/protocol";
import { i18n } from "../i18n";

export function taskTextSize(name: string, command: string) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name).byteLength;
  const commandBytes = encoder.encode(command).byteLength;
  return {
    nameBytes,
    commandBytes,
    nameTooLong: nameBytes > taskTextLimits.nameBytes,
    commandTooLong: commandBytes > taskTextLimits.commandBytes,
  };
}

export type SchedulePreset = "once" | "hourly" | "daily" | "weekly" | "cron";
interface ScheduleForm {
  preset: SchedulePreset;
  time: string;
  weekday: string;
  once: string;
  cron: string;
}

export function localDateTime(at: string) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleForm(schedule?: TaskSchedule): ScheduleForm {
  const form: ScheduleForm = {
    preset: "daily",
    time: "09:00",
    weekday: "1",
    once: "",
    cron: "0 9 * * *",
  };
  if (!schedule) return form;
  if (schedule.kind === "once")
    return { ...form, preset: "once", once: localDateTime(schedule.at) };
  const expression = schedule.expression;
  if (expression === "0 * * * *") return { ...form, preset: "hourly" };
  const common = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(expression);
  return common
    ? {
        ...form,
        preset: common[3] === "*" ? "daily" : "weekly",
        time: `${common[2]!.padStart(2, "0")}:${common[1]!.padStart(2, "0")}`,
        weekday: common[3] === "*" ? "1" : common[3]!,
      }
    : { ...form, preset: "cron", cron: expression };
}

export function formSchedule(
  form: ScheduleForm,
  original?: TaskSchedule,
  initialOnce?: string,
): TaskSchedule | null {
  // An unchanged date control must not lose the saved seconds or consume a new once plan.
  if (original?.kind === "once" && form.preset === "once" && form.once === initialOnce)
    return original;
  if (form.preset === "once") {
    const date = new Date(form.once);
    if (!Number.isFinite(date.valueOf()) || localDateTime(date.toISOString()) !== form.once)
      return null;
    return { kind: "once", at: date.toISOString() };
  }
  const [hour, minute] = form.time.split(":").map(Number);
  const expression =
    form.preset === "cron"
      ? form.cron
      : form.preset === "hourly"
        ? "0 * * * *"
        : `${minute} ${hour} * * ${form.preset === "weekly" ? form.weekday : "*"}`;
  return { kind: "cron", expression };
}

export function sameSchedule(before: TaskSchedule, after: TaskSchedule) {
  return before.kind === "once"
    ? after.kind === "once" && before.at === after.at
    : after.kind === "cron" && before.expression === after.expression;
}

export function taskChanges(
  before: ScheduledTask,
  after: ScheduledTaskInput,
): Partial<ScheduledTaskInput> {
  const changes: Partial<ScheduledTaskInput> = {};
  for (const key of taskInputKeys) {
    if (key === "schedule") {
      if (!sameSchedule(before.schedule, after.schedule)) changes.schedule = after.schedule;
    } else if (after[key] !== undefined && after[key] !== before[key]) changes[key] = after[key];
  }
  return changes;
}

export function taskTime(at: string, language: string | undefined) {
  const date = new Date(at);
  if (!Number.isFinite(date.valueOf())) return i18n.t(($) => $.schedules.timeUnavailable);
  const parts = new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const time = parts
    .filter((part) => part.type !== "timeZoneName")
    .map((part) => part.value)
    .join("")
    .trim();
  const offset = parts.find((part) => part.type === "timeZoneName")!.value;
  return `${time} ${offset}`;
}
