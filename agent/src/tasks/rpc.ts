import { taskLimits } from "../limits.js";
import {
  AppError,
  integer,
  record,
  string,
  type RpcResult,
  type ScheduledTaskInput,
} from "@kiteline/shared/protocol";
import { ScheduledTasks } from "./index.js";
import { previewSchedule, taskId } from "./schedule.js";

export const scheduleMethods = [
  "tasks.list",
  "tasks.get",
  "tasks.preview",
  "tasks.create",
  "tasks.update",
  "tasks.pause",
  "tasks.resume",
  "tasks.acknowledge",
  "tasks.delete",
  "tasks.run",
  "runs.list",
  "runs.get",
  "runs.output",
  "runs.stop",
] as const;
export type ScheduleMethod = (typeof scheduleMethods)[number];

export function isScheduleMethod(method: string): method is ScheduleMethod {
  return scheduleMethods.some((candidate) => candidate === method);
}

export function scheduleRpc(
  tasks: ScheduledTasks,
  method: ScheduleMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
) {
  tasks.assertAvailable();
  const offset = () =>
    params.offset === undefined ? 0 : integer(params.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
  const acknowledge = () =>
    params.acknowledgeRunId === undefined
      ? undefined
      : taskId(params.acknowledgeRunId, "acknowledgeRunId");
  switch (method) {
    case "tasks.list":
      return tasks.list(offset()) satisfies RpcResult<typeof method>;
    case "tasks.get":
      return tasks.get(taskId(params.taskId)) satisfies RpcResult<typeof method>;
    case "tasks.preview":
      return previewSchedule(params.schedule, params.timezone) satisfies RpcResult<typeof method>;
    case "tasks.create":
      return tasks.create(taskId(params.taskId), params.input, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.update": {
      const changes = record(params.changes);
      for (const key of Object.keys(changes))
        if (!["name", "command", "schedule", "cwd", "timezone"].includes(key))
          throw new AppError("invalid_argument", `Unknown task field: ${key}`);
      return tasks.update(
        taskId(params.taskId),
        integer(params.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
        changes as Partial<ScheduledTaskInput>,
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    }
    case "tasks.pause":
      return tasks.setPaused(taskId(params.taskId), true, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.resume":
      return tasks.setPaused(taskId(params.taskId), false, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.acknowledge":
      return tasks.acknowledge(
        taskId(params.taskId),
        taskId(params.runId, "runId"),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "tasks.delete":
      return tasks.delete(taskId(params.taskId), acknowledge(), signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.run":
      return tasks.start(
        taskId(params.taskId),
        taskId(params.runId, "runId"),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "runs.list":
      return tasks.runs(taskId(params.taskId), offset()) satisfies RpcResult<typeof method>;
    case "runs.get":
      return tasks.run(taskId(params.runId, "runId")) satisfies RpcResult<typeof method>;
    case "runs.stop":
      return tasks.stop(taskId(params.runId, "runId"), signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "runs.output": {
      const stream = string(params.stream, "stream");
      if (stream !== "stdout" && stream !== "stderr")
        throw new AppError("invalid_argument", "stream must be stdout or stderr");
      return tasks.output(
        taskId(params.runId, "runId"),
        stream,
        offset(),
        params.limit === undefined
          ? taskLimits.outputReadBytes
          : integer(params.limit, "limit", 4, taskLimits.outputReadBytes),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    }
    default: {
      const unhandled: never = method;
      throw new AppError("unsupported", `Unsupported operation: ${unhandled}`);
    }
  }
}
