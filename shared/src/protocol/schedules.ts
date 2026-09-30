import { AppError, integer } from "./index.js";

const taskValues = {
  state: ["active", "paused"],
  runState: [
    "starting",
    "running",
    "stopping",
    "succeeded",
    "failed",
    "stopped",
    "skipped",
    "unknown",
  ],
  trigger: ["scheduled", "manual"],
  onceStatus: ["pending", "consumed", "missed"],
  reasonCode: [
    "missed",
    "overlap",
    "capacity",
    "start_failed",
    "exit_nonzero",
    "requested_stop",
    "agent_stop",
    "unconfirmed",
  ],
} as const;
type TaskValue<K extends keyof typeof taskValues> = (typeof taskValues)[K][number];

export function taskValue<K extends keyof typeof taskValues>(
  value: unknown,
  kind: K,
): TaskValue<K> {
  const found = taskValues[kind].find((item) => item === value);
  if (!found) throw new AppError("invalid_argument", `Invalid task ${kind}`);
  return found as TaskValue<K>;
}

export function taskExitCode(value: unknown) {
  return integer(value, "exitCode", 0, 0xffffffff);
}

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
