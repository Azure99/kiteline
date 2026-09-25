import {
  AppError,
  integer,
  record,
  string,
  taskRunActive,
  type ScheduledTask,
  type TaskRun,
} from "@kiteline/shared/protocol";
import { nextOccurrence, taskFields, taskId } from "./schedule.js";

export interface TaskRecord {
  task: ScheduledTask;
  lastScheduledAt?: string;
  runs: TaskRun[];
}

function choice<const T extends string>(value: unknown, values: readonly T[], name: string): T {
  const found = values.find((item) => value === item);
  if (!found) throw new AppError("invalid_argument", `Invalid ${name}`);
  return found;
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

// A damaged definition can be isolated locally only when all execution identities are known.
export function taskOwnership(value: unknown, filename: string) {
  const input = record(value),
    task = record(input.task);
  const id = taskId(task.id);
  if (filename !== `${id}.json` || !Array.isArray(input.runs))
    throw new AppError("invalid_argument", "Invalid scheduled task identity or runs");
  const state = choice(task.state, ["active", "paused"], "task state");
  const seen = new Set<string>();
  const runs = input.runs.map((value) => {
    const run = record(value),
      runId = taskId(run.id, "runId");
    if (taskId(run.taskId) !== id || seen.has(runId))
      throw new AppError(
        "invalid_argument",
        "Run identity is duplicated or belongs to another task",
      );
    seen.add(runId);
    return {
      id: runId,
      state: choice(
        run.state,
        ["starting", "running", "stopping", "succeeded", "failed", "stopped", "skipped", "unknown"],
        "run state",
      ),
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
  return { id, state, reviewRunId, runs, occupied };
}

function storedFields(value: unknown) {
  const input = record(value);
  string(input.cwd, "cwd");
  string(input.timezone, "timezone", 128);
  const fields = taskFields(input);
  nextOccurrence(fields.schedule, fields.timezone, new Date());
  return fields;
}

export function taskRecord(value: unknown, filename: string): TaskRecord {
  const input = record(value),
    task = record(input.task);
  const ownership = taskOwnership(value, filename);
  const fields = storedFields(task);
  const onceStatus =
    fields.schedule.kind === "once"
      ? choice(task.onceStatus, ["pending", "consumed", "missed"], "onceStatus")
      : undefined;
  if (fields.schedule.kind === "cron" && task.onceStatus !== undefined)
    throw new AppError("invalid_argument", "Cron task has a one-shot status");
  const runs = (input.runs as unknown[]).map((value, index): TaskRun => {
    const run = record(value),
      parameters = record(run.parameters),
      output = record(run.output);
    const state = ownership.runs[index]!.state;
    const endedAt = optionalTime(run.endedAt, "endedAt");
    if ((!taskRunActive(state) && !endedAt) || typeof output.truncated !== "boolean")
      throw new AppError("invalid_argument", "Invalid run result or output");
    return {
      ...ownership.runs[index]!,
      taskId: ownership.id,
      trigger: choice(run.trigger, ["manual", "scheduled"], "trigger"),
      acceptedAt: timestamp(run.acceptedAt, "acceptedAt"),
      scheduledAt: optionalTime(run.scheduledAt, "scheduledAt"),
      startedAt: optionalTime(run.startedAt, "startedAt"),
      endedAt,
      parameters: {
        ...storedFields(parameters),
        taskRevision: integer(parameters.taskRevision, "taskRevision", 1, Number.MAX_SAFE_INTEGER),
      },
      pid: run.pid === undefined ? undefined : integer(run.pid, "pid", 1, 2147483647),
      exitCode:
        run.exitCode === undefined || run.exitCode === null
          ? run.exitCode
          : integer(run.exitCode, "exitCode", -2147483648, 2147483647),
      signal:
        run.signal === undefined || run.signal === null
          ? run.signal
          : string(run.signal, "signal", 128),
      reasonCode:
        run.reasonCode === undefined
          ? undefined
          : choice(
              run.reasonCode,
              [
                "missed",
                "overlap",
                "capacity",
                "start_failed",
                "exit_nonzero",
                "requested_stop",
                "agent_stop",
                "unconfirmed",
              ],
              "reasonCode",
            ),
      diagnostic: diagnostic(run.diagnostic),
      output: {
        stdoutBytes: integer(output.stdoutBytes, "stdoutBytes", 0, Number.MAX_SAFE_INTEGER),
        stderrBytes: integer(output.stderrBytes, "stderrBytes", 0, Number.MAX_SAFE_INTEGER),
        truncated: output.truncated,
        error: diagnostic(output.error),
      },
    };
  });
  return {
    task: {
      ...fields,
      id: ownership.id,
      revision: integer(task.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
      state: ownership.state,
      reviewRunId: ownership.reviewRunId,
      nextRunAt: task.nextRunAt === null ? null : timestamp(task.nextRunAt, "nextRunAt"),
      onceStatus,
    },
    lastScheduledAt: optionalTime(input.lastScheduledAt, "lastScheduledAt"),
    runs,
  };
}
