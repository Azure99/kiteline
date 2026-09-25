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
  state: "active" | "paused";
  reviewRunId?: string;
  nextRunAt: string | null;
  onceStatus?: "pending" | "consumed" | "missed";
}

export interface TaskRunSummary {
  id: string;
  taskId: string;
  trigger: "scheduled" | "manual";
  scheduledAt?: string;
  acceptedAt: string;
  startedAt?: string;
  endedAt?: string;
  state:
    | "starting"
    | "running"
    | "stopping"
    | "succeeded"
    | "failed"
    | "stopped"
    | "skipped"
    | "unknown";
  exitCode?: number | null;
  signal?: string | null;
  reasonCode?:
    | "missed"
    | "overlap"
    | "capacity"
    | "start_failed"
    | "exit_nonzero"
    | "requested_stop"
    | "agent_stop"
    | "unconfirmed";
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

export const taskLimits = {
  nameBytes: 256,
  commandBytes: 16 * 1024,
  outputReadBytes: 32 * 1024,
  diagnosticBytes: 2048,
  pageEntries: 50,
  lateToleranceMs: 5000,
  stopGraceMs: 5000,
  outputPollMs: 2000,
} as const;

export function taskRunActive(state: TaskRunSummary["state"]) {
  return state === "starting" || state === "running" || state === "stopping";
}

export function taskRunSummary(run: TaskRun): TaskRunSummary {
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
