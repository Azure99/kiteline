type TaskValues = {
  state: "active" | "paused";
  runState:
    | "starting"
    | "running"
    | "stopping"
    | "succeeded"
    | "failed"
    | "stopped"
    | "skipped"
    | "unknown";
  trigger: "scheduled" | "manual";
  onceStatus: "pending" | "consumed" | "missed";
  reasonCode:
    | "missed"
    | "overlap"
    | "capacity"
    | "start_failed"
    | "exit_nonzero"
    | "requested_stop"
    | "agent_stop"
    | "unconfirmed";
};
type TaskValue<K extends keyof TaskValues> = TaskValues[K];

export type TaskSchedule = { kind: "cron"; expression: string } | { kind: "once"; at: string };

export interface ScheduledTaskInput {
  name: string;
  command: string;
  schedule: TaskSchedule;
  cwd?: string;
  timezone?: string;
}

export interface ScheduledTask extends Required<ScheduledTaskInput> {
  id: string;
  revision: number;
  state: TaskValue<"state">;
  reviewRunId?: string;
  nextRunAt: string | null;
  onceStatus?: TaskValue<"onceStatus">;
}

export interface TaskRunSummary {
  id: string;
  taskId: string;
  trigger: TaskValue<"trigger">;
  scheduledAt?: string;
  acceptedAt: string;
  startedAt?: string;
  endedAt?: string;
  state: TaskValue<"runState">;
  exitCode?: number | null;
  signal?: string | null;
  reasonCode?: TaskValue<"reasonCode">;
}

export interface TaskRun extends TaskRunSummary {
  parameters: Required<ScheduledTaskInput> & { taskRevision: number };
  pid?: number;
  diagnostic?: string;
  output: { stdoutBytes: number; stderrBytes: number; truncated: boolean; error?: string };
}

export interface ScheduledTaskSummary {
  id: string;
  name: string;
  state: ScheduledTask["state"];
  reviewRunId?: string;
  nextRunAt: string | null;
  onceStatus?: ScheduledTask["onceStatus"];
  currentRun?: TaskRunSummary;
  latestRun?: TaskRunSummary;
}

export interface TaskSnapshot {
  revision: number;
  storageError?: true;
  items: ScheduledTaskSummary[];
}

export interface DeviceTaskSummary {
  deviceId: string;
  observedAt: string | null;
  snapshot: TaskSnapshot | null;
  current: boolean;
}

export interface TaskOutput {
  text: string;
  offset: number;
  nextOffset: number;
  storedBytes: number;
  truncated: boolean;
  finished: boolean;
}

export function taskRunActive(state: TaskRunSummary["state"]) {
  return state === "starting" || state === "running" || state === "stopping";
}

export function taskRunSummary(run: TaskRunSummary): TaskRunSummary {
  const {
    id,
    taskId,
    trigger,
    scheduledAt,
    acceptedAt,
    startedAt,
    endedAt,
    state,
    exitCode,
    signal,
    reasonCode,
  } = run;
  return {
    id,
    taskId,
    trigger,
    scheduledAt,
    acceptedAt,
    startedAt,
    endedAt,
    state,
    exitCode,
    signal,
    reasonCode,
  };
}
