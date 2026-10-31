import { Cron } from "croner";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { devicePath, realPath } from "../files/paths.js";
import { windowsNative } from "@kiteline/shared/windows/native";
import {
  AppError,
  record,
  string,
  taskTextLimits,
  type ScheduledTaskInput,
  type TaskSchedule,
} from "@kiteline/shared/protocol";

export function checkFileId(value: unknown, name = "taskId") {
  const id = string(value, name, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AppError("invalid_argument", `Invalid ${name}`);
  return id;
}

function text(value: unknown, name: string, bytes: number) {
  const result = string(value, name, bytes);
  if (Buffer.byteLength(result) > bytes)
    throw new AppError("invalid_argument", `${name} is too long`);
  return result;
}

export function checkTimezone(value?: unknown) {
  const zone =
    value === undefined
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : string(value, "timezone", 128);
  if (/^[+-]/.test(zone))
    throw new AppError("invalid_argument", "Use an IANA timezone, not a fixed offset");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new AppError("invalid_argument", "Invalid IANA timezone");
  }
}

export function checkSchedule(value: unknown): TaskSchedule {
  const input = record(value);
  if (input.kind === "cron") {
    const expression = string(input.expression, "cron expression", 256).trim().replace(/\s+/g, " ");
    if (!/^[\d*,/-]+(?: [\d*,/-]+){4}$/.test(expression))
      throw new AppError("invalid_argument", "Use a numeric five-field cron expression");
    return { kind: "cron", expression };
  }
  if (input.kind === "once") {
    const at = string(input.at, "at", 64);
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      at,
    );
    if (
      !match ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(match[1] + "Z").toISOString().slice(0, 19) !== match[1]
    )
      throw new AppError("invalid_argument", "Use an ISO timestamp with a timezone offset");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  throw new AppError("invalid_argument", "Unknown schedule kind");
}

function wallClock(timezone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  // Local fields of an instant, read as UTC milliseconds.
  return (ms: number) => {
    const field: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
    for (const { type, value } of format.formatToParts(ms)) field[type] = Number(value);
    const { year, month, day, hour, minute, second } = field;
    return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  };
}

// When clocks go back, a repeated wall time also occurs one offset change earlier.
function firstInstant(candidate: Date, wall: (ms: number) => number) {
  const ms = candidate.getTime();
  const offset = (at: number) => wall(at) - at;
  const earlier = ms - (offset(ms - 86_400_000) - offset(ms));
  return earlier < ms && wall(earlier) === wall(ms) ? new Date(earlier) : candidate;
}
export function nextOccurrence(schedule: TaskSchedule, timezone: string, after: Date): Date | null {
  if (schedule.kind === "once") return new Date(schedule.at) > after ? new Date(schedule.at) : null;
  try {
    const cron = new Cron(schedule.expression, { timezone, mode: "5-part", domAndDow: false });
    const wall = wallClock(timezone);
    // Croner can choose either pass of a repeated wall time. Use its first occurrence,
    // reject shifted gap times, and require a result strictly after the reference.
    for (let candidate = cron.nextRun(after); candidate; candidate = cron.nextRun(candidate)) {
      if (!cron.match(candidate)) continue;
      const first = firstInstant(candidate, wall);
      if (first > after) return first;
    }
    return null;
  } catch (error) {
    throw new AppError(
      "invalid_argument",
      error instanceof Error ? error.message : "Invalid schedule",
    );
  }
}

export function previewSchedule(input: unknown, timezone?: unknown) {
  const schedule = checkSchedule(input);
  const zone = checkTimezone(timezone);
  const nextRunAts: string[] = [];
  let after = new Date();
  for (let n = 0; n < 5; n++) {
    const next = nextOccurrence(schedule, zone, after);
    if (!next) break;
    nextRunAts.push(next.toISOString());
    after = next;
  }
  if (!nextRunAts.length)
    throw new AppError("invalid_argument", "Schedule has no future occurrence");
  return { timezone: zone, nextRunAts };
}

function taskFields(value: unknown): Required<ScheduledTaskInput> {
  const input = record(value);
  const name = text(input.name, "name", taskTextLimits.nameBytes);
  const command = text(input.command, "command", taskTextLimits.commandBytes);
  const schedule = checkSchedule(input.schedule);
  const timezone = checkTimezone(input.timezone);
  const cwd = devicePath(
    input.cwd === undefined
      ? process.platform === "win32"
        ? windowsNative().identity().home
        : homedir()
      : input.cwd,
  );
  return { name, command, schedule, timezone, cwd };
}

export async function checkTaskInput(value: unknown, previousCwd?: string) {
  const fields = taskFields(value);
  if (fields.cwd === previousCwd) return fields;
  fields.cwd = await realPath(fields.cwd);
  if (!(await stat(fields.cwd)).isDirectory())
    throw new AppError("invalid_argument", "cwd must be a directory");
  return fields;
}
