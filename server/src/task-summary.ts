import {
  AppError,
  integer,
  record,
  taskRunSummary,
  type ScheduledTaskSummary,
  type TaskRunSummary,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";

function runSummary(value: unknown): TaskRunSummary | undefined {
  return value === undefined
    ? undefined
    : taskRunSummary(record(value) as unknown as TaskRunSummary);
}

export function taskSnapshot(value: unknown): TaskSnapshot {
  const input = record(value);
  const revision = integer(input.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(input.items)) throw new AppError("invalid_argument", "Invalid task summaries");
  if (input.storageError !== undefined) return { revision, storageError: true, items: [] };
  const items = input.items.map((value): ScheduledTaskSummary => {
    const item = record(value) as unknown as ScheduledTaskSummary;
    return {
      id: item.id,
      name: item.name,
      state: item.state,
      reviewRunId: item.reviewRunId,
      nextRunAt: item.nextRunAt,
      onceStatus: item.onceStatus,
      currentRun: runSummary(item.currentRun),
      latestRun: runSummary(item.latestRun),
    };
  });
  return { revision, items };
}
