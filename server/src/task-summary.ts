import {
  AppError,
  integer,
  record,
  string,
  taskLimits,
  type ScheduledTaskSummary,
  type TaskRunSummary,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";

function optionalText(value: unknown, name: string) {
  return value === undefined ? undefined : string(value, name, 128);
}

function choice<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
  const result = choices.find((item) => item === value);
  if (!result) throw new AppError("invalid_argument", `Invalid ${name}`);
  return result;
}

function runSummary(value: unknown): TaskRunSummary | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  return {
    id: string(input.id, "run id", 128),
    taskId: string(input.taskId, "task id", 128),
    trigger: choice(input.trigger, ["manual", "scheduled"], "trigger"),
    scheduledAt: optionalText(input.scheduledAt, "scheduledAt"),
    acceptedAt: string(input.acceptedAt, "acceptedAt", 128),
    startedAt: optionalText(input.startedAt, "startedAt"),
    endedAt: optionalText(input.endedAt, "endedAt"),
    state: choice(
      input.state,
      ["starting", "running", "stopping", "succeeded", "failed", "stopped", "skipped", "unknown"],
      "run state",
    ),
    exitCode:
      input.exitCode === undefined || input.exitCode === null
        ? input.exitCode
        : integer(input.exitCode, "exitCode", -2147483648, 2147483647),
    signal: input.signal === null ? null : optionalText(input.signal, "signal"),
    reasonCode:
      input.reasonCode === undefined
        ? undefined
        : choice(
            input.reasonCode,
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
  };
}

export function taskSnapshot(value: unknown): TaskSnapshot {
  const input = record(value);
  const revision = integer(input.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(input.items)) throw new AppError("invalid_argument", "Invalid task summaries");
  const seen = new Set<string>();
  const items: ScheduledTaskSummary[] = input.items.map((value) => {
    const item = record(value);
    const id = string(item.id, "task id", 128);
    const name = string(item.name, "name", taskLimits.nameBytes);
    if (Buffer.byteLength(name) > taskLimits.nameBytes || seen.has(id))
      throw new AppError("invalid_argument", "Invalid task summary name or duplicate ID");
    seen.add(id);
    const currentRun = runSummary(item.currentRun),
      latestRun = runSummary(item.latestRun);
    if ((currentRun && currentRun.taskId !== id) || (latestRun && latestRun.taskId !== id))
      throw new AppError("invalid_argument", "Run summary belongs to another task");
    const state = choice(item.state, ["active", "paused"], "task state");
    const reviewRunId = optionalText(item.reviewRunId, "reviewRunId");
    if (reviewRunId && (state !== "paused" || item.nextRunAt !== null))
      throw new AppError("invalid_argument", "Pending review task must stay paused");
    return {
      id,
      name,
      state,
      reviewRunId,
      nextRunAt: item.nextRunAt === null ? null : string(item.nextRunAt, "nextRunAt", 128),
      onceStatus:
        item.onceStatus === undefined
          ? undefined
          : choice(item.onceStatus, ["pending", "consumed", "missed"], "onceStatus"),
      currentRun,
      latestRun,
    };
  });
  return { revision, items };
}
