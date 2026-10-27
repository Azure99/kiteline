import {
  AppError,
  integer,
  record,
  taskSummary,
  type ScheduledTaskSummary,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";

export function projectTaskSnapshot(value: unknown): TaskSnapshot {
  const input = record(value);
  const revision = integer(input.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(input.items)) throw new AppError("invalid_argument", "Invalid task summaries");
  if (input.storageError !== undefined) return { revision, storageError: true, items: [] };
  const items = input.items.map((value): ScheduledTaskSummary => {
    const item = record(value);
    if (item.currentRun !== undefined) record(item.currentRun);
    if (item.latestRun !== undefined) record(item.latestRun);
    return taskSummary(item as unknown as ScheduledTaskSummary);
  });
  return { revision, items };
}
