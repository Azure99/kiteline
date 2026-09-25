import { Cron } from "croner";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  AppError,
  record,
  string,
  taskLimits,
  type ScheduledTaskInput,
  type TaskSchedule,
} from "@kiteline/shared/protocol";

export function taskId(value: unknown, name = "taskId") {
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

export function nextOccurrence(schedule: TaskSchedule, timezone: string, after: Date): Date | null {
  if (schedule.kind === "once") return new Date(schedule.at) > after ? new Date(schedule.at) : null;
  try {
    const cron = new Cron(schedule.expression, { timezone, mode: "5-part", domAndDow: false });
    let candidate = cron.nextRun(after);
    // Croner moves missing DST wall times forward; those are not occurrences of our schedule.
    while (candidate && !cron.match(candidate)) candidate = cron.nextRun(candidate);
    return candidate;
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

export function taskFields(value: unknown): Required<ScheduledTaskInput> {
  const input = record(value);
  const name = text(input.name, "name", taskLimits.nameBytes);
  const command = text(input.command, "command", taskLimits.commandBytes);
  const schedule = checkSchedule(input.schedule);
  const timezone = checkTimezone(input.timezone);
  const cwd = input.cwd === undefined ? homedir() : string(input.cwd, "cwd");
  if (!isAbsolute(cwd)) throw new AppError("invalid_argument", "cwd must be an absolute directory");
  return { name, command, schedule, timezone, cwd };
}

export async function checkTaskInput(value: unknown, previousCwd?: string) {
  const fields = taskFields(value);
  if (fields.cwd === previousCwd) return fields;
  fields.cwd = await realpath(fields.cwd);
  if (!(await stat(fields.cwd)).isDirectory())
    throw new AppError("invalid_argument", "cwd must be a directory");
  return fields;
}
