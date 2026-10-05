import { taskLimits } from "../limits.js";
import {
  AppError,
  integer,
  record,
  string,
  rpcMutates,
  type RpcMethod,
  type RpcResult,
  type ScheduledTaskInput,
} from "@kiteline/shared/protocol";
import { ScheduledTasks } from "./index.js";
import { previewSchedule, checkFileId } from "./schedule.js";

export type ScheduleMethod = Extract<RpcMethod, `tasks.${string}` | `runs.${string}`>;
export const scheduleMethods = Object.keys(rpcMutates).filter(
  (method): method is ScheduleMethod => method.startsWith("tasks.") || method.startsWith("runs."),
);

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
      : checkFileId(params.acknowledgeRunId, "acknowledgeRunId");
  switch (method) {
    case "tasks.list":
      return tasks.list(offset()) satisfies RpcResult<typeof method>;
    case "tasks.get":
      return tasks.get(checkFileId(params.taskId)) satisfies RpcResult<typeof method>;
    case "tasks.preview":
      return previewSchedule(params.schedule, params.timezone) satisfies RpcResult<typeof method>;
    case "tasks.create":
      return tasks.create(checkFileId(params.taskId), params.input, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.update": {
      const changes = record(params.changes);
      for (const key of Object.keys(changes))
        if (!["name", "command", "schedule", "cwd", "timezone"].includes(key))
          throw new AppError("invalid_argument", `Unknown task field: ${key}`);
      return tasks.update(
        checkFileId(params.taskId),
        integer(params.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
        changes as Partial<ScheduledTaskInput>,
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    }
    case "tasks.pause":
      return tasks.setPaused(checkFileId(params.taskId), true, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.resume":
      return tasks.setPaused(checkFileId(params.taskId), false, signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.acknowledge":
      return tasks.acknowledge(
        checkFileId(params.taskId),
        checkFileId(params.runId, "runId"),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "tasks.delete":
      return tasks.delete(checkFileId(params.taskId), acknowledge(), signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "tasks.run":
      return tasks.start(
        checkFileId(params.taskId),
        checkFileId(params.runId, "runId"),
        signal,
      ) satisfies Promise<RpcResult<typeof method>>;
    case "runs.list":
      return tasks.listRuns(checkFileId(params.taskId), offset()) satisfies RpcResult<
        typeof method
      >;
    case "runs.get":
      return tasks.getRun(checkFileId(params.runId, "runId")) satisfies RpcResult<typeof method>;
    case "runs.stop":
      return tasks.stop(checkFileId(params.runId, "runId"), signal) satisfies Promise<
        RpcResult<typeof method>
      >;
    case "runs.output": {
      const stream = string(params.stream, "stream");
      if (stream !== "stdout" && stream !== "stderr")
        throw new AppError("invalid_argument", "stream must be stdout or stderr");
      return tasks.output(
        checkFileId(params.runId, "runId"),
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
