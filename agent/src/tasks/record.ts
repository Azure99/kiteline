import {
  AppError,
  integer,
  record,
  string,
  taskRunActive,
  taskValue,
  taskExitCode,
  taskLimits,
  type ScheduledTask,
  type TaskRun,
  type TaskSchedule,
} from "@kiteline/shared/protocol";
import { checkTimezone, nextOccurrence, taskFields, taskId } from "./schedule.js";

export interface TaskRecord {
  task: ScheduledTask;
  lastScheduledAt?: string;
  runs: TaskRun[];
}

function timestamp(value: unknown, name: string) {
  const text = string(value, name, 64);
  if (!Number.isFinite(Date.parse(text))) throw new AppError("invalid_argument", `Invalid ${name}`);
  return text;
}

function optionalTime(value: unknown, name: string) {
  return value === undefined ? undefined : timestamp(value, name);
}

function diagnostic(value: unknown) {
  if (value !== undefined && typeof value !== "string")
    throw new AppError("invalid_argument", "Invalid run diagnostic");
  return value;
}

function historicalFields(input: Record<string, unknown>): TaskRun["parameters"] {
  const schedule = record(input.schedule);
  let plan: TaskSchedule;
  if (schedule.kind === "cron")
    plan = { kind: "cron", expression: string(schedule.expression, "cron expression", 256) };
  else if (schedule.kind === "once") plan = { kind: "once", at: string(schedule.at, "at", 64) };
  else throw new AppError("invalid_argument", "Unknown schedule kind");
  return {
    name: string(input.name, "name", taskLimits.nameBytes),
    command: string(input.command, "command", taskLimits.commandBytes),
    cwd: string(input.cwd, "cwd"),
    timezone: checkTimezone(string(input.timezone, "timezone", 128)),
    schedule: plan,
    taskRevision: integer(input.taskRevision, "taskRevision", 1, Number.MAX_SAFE_INTEGER),
  };
}

export function taskRecord(value: unknown, filename: string): TaskRecord {
  const input = record(value),
    task = record(input.task);
  const id = taskId(task.id);
  if (filename !== `${id}.json` || !Array.isArray(input.runs))
    throw new AppError("invalid_argument", "Invalid scheduled task identity or runs");
  const state = taskValue(task.state, "state");
  string(task.cwd, "cwd");
  string(task.timezone, "timezone", 128);
  const fields = taskFields(task);
  const next = nextOccurrence(fields.schedule, fields.timezone, new Date());
  if (fields.schedule.kind === "cron" && !next)
    throw new AppError("invalid_argument", "Schedule has no future occurrence");
  const onceStatus =
    fields.schedule.kind === "once" ? taskValue(task.onceStatus, "onceStatus") : undefined;
  if (fields.schedule.kind === "cron" && task.onceStatus !== undefined)
    throw new AppError("invalid_argument", "Cron task has a one-shot status");
  const seen = new Set<string>();
  const runs = input.runs.map((value): TaskRun => {
    const run = record(value),
      runId = taskId(run.id, "runId");
    if (taskId(run.taskId) !== id || seen.has(runId))
      throw new AppError(
        "invalid_argument",
        "Run identity is duplicated or belongs to another task",
      );
    seen.add(runId);
    const state = taskValue(run.state, "runState");
    const endedAt = optionalTime(run.endedAt, "endedAt");
    const output = record(run.output);
    if ((!taskRunActive(state) && !endedAt) || typeof output.truncated !== "boolean")
      throw new AppError("invalid_argument", "Invalid run result or output");
    return {
      id: runId,
      taskId: id,
      state,
      trigger: taskValue(run.trigger, "trigger"),
      acceptedAt: timestamp(run.acceptedAt, "acceptedAt"),
      scheduledAt: optionalTime(run.scheduledAt, "scheduledAt"),
      startedAt: optionalTime(run.startedAt, "startedAt"),
      endedAt,
      parameters: historicalFields(record(run.parameters)),
      pid: run.pid === undefined ? undefined : integer(run.pid, "pid", 1, 0xffffffff),
      exitCode:
        run.exitCode === undefined || run.exitCode === null
          ? run.exitCode
          : taskExitCode(run.exitCode),
      signal:
        run.signal === undefined || run.signal === null
          ? run.signal
          : string(run.signal, "signal", 128),
      reasonCode:
        run.reasonCode === undefined ? undefined : taskValue(run.reasonCode, "reasonCode"),
      diagnostic: diagnostic(run.diagnostic),
      output: {
        stdoutBytes: integer(output.stdoutBytes, "stdoutBytes", 0, Number.MAX_SAFE_INTEGER),
        stderrBytes: integer(output.stderrBytes, "stderrBytes", 0, Number.MAX_SAFE_INTEGER),
        truncated: output.truncated,
        error: diagnostic(output.error),
      },
    };
  });
  const reviewRunId =
    task.reviewRunId === undefined ? undefined : taskId(task.reviewRunId, "reviewRunId");
  if (
    reviewRunId &&
    (state !== "paused" ||
      task.nextRunAt !== null ||
      !runs.some((run) => run.id === reviewRunId && run.state === "unknown"))
  )
    throw new AppError("invalid_argument", "Invalid pending review identity");
  const occupied = runs.filter((run) => taskRunActive(run.state)).map((run) => run.id);
  if (reviewRunId) occupied.push(reviewRunId);
  if (occupied.length > 1)
    throw new AppError("invalid_argument", "Multiple unfinished runs belong to one task");
  return {
    task: {
      ...fields,
      id,
      revision: integer(task.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
      state,
      reviewRunId,
      nextRunAt: task.nextRunAt === null ? null : timestamp(task.nextRunAt, "nextRunAt"),
      onceStatus,
    },
    lastScheduledAt: optionalTime(input.lastScheduledAt, "lastScheduledAt"),
    runs,
  };
}
