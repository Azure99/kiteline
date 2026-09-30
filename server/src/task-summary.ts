import {
  AppError,
  integer,
  record,
  string,
  taskLimits,
  taskValue,
  taskExitCode,
  type ScheduledTaskSummary,
  type TaskRunSummary,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";

function optionalText(value: unknown, name: string) {
  return value === undefined ? undefined : string(value, name, 128);
}

function runSummary(value: unknown): TaskRunSummary | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  return {
    id: string(input.id, "run id", 128),
    taskId: string(input.taskId, "task id", 128),
    trigger: taskValue(input.trigger, "trigger"),
    scheduledAt: optionalText(input.scheduledAt, "scheduledAt"),
    acceptedAt: string(input.acceptedAt, "acceptedAt", 128),
    startedAt: optionalText(input.startedAt, "startedAt"),
    endedAt: optionalText(input.endedAt, "endedAt"),
    state: taskValue(input.state, "runState"),
    exitCode:
      input.exitCode === undefined || input.exitCode === null
        ? input.exitCode
        : taskExitCode(input.exitCode),
    signal: input.signal === null ? null : optionalText(input.signal, "signal"),
    reasonCode:
      input.reasonCode === undefined ? undefined : taskValue(input.reasonCode, "reasonCode"),
  };
}

export function taskSnapshot(value: unknown): TaskSnapshot {
  const input = record(value);
  const revision = integer(input.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(input.items)) throw new AppError("invalid_argument", "Invalid task summaries");
  if (input.storageError !== undefined) {
    if (input.storageError !== true || input.items.length)
      throw new AppError("invalid_argument", "Invalid task storage error");
    return { revision, storageError: true, items: [] };
  }
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
    const state = taskValue(item.state, "state");
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
        item.onceStatus === undefined ? undefined : taskValue(item.onceStatus, "onceStatus"),
      currentRun,
      latestRun,
    };
  });
  return { revision, items };
}
