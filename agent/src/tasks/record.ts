import { AppError, record, type ScheduledTask, type TaskRun } from "@kiteline/shared/protocol";
import { checkFileId } from "./schedule.js";

export interface TaskRecord {
  task: ScheduledTask;
  lastScheduledAt?: string;
  runs: TaskRun[];
}

export function taskRecord(value: unknown, filename: string): TaskRecord {
  const input = record(value),
    task = record(input.task);
  const id = checkFileId(task.id);
  if (filename !== `${id}.json` || !Array.isArray(input.runs))
    throw new AppError("invalid_argument", "Invalid scheduled task identity or runs");
  return {
    task: { ...task, id } as unknown as ScheduledTask,
    lastScheduledAt: input.lastScheduledAt as string | undefined,
    runs: input.runs.map((value): TaskRun => {
      const run = record(value) as unknown as TaskRun;
      return { ...run, id: checkFileId(run.id, "runId"), taskId: id };
    }),
  };
}
