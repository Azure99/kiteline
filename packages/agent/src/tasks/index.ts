import { agentLimits, taskLimits } from "../limits.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  OperationError,
  asError,
  taskInput,
  taskRunActive,
  taskRunSummary,
  taskSummary,
  type ScheduledTaskInput,
  type ScheduledTaskSummary,
  type TaskOutput,
  type TaskRun,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";
import { atomicJson, readJson } from "@kiteline/shared/node/files";
import { stateFiles, type AgentConfig } from "../config.js";
import { checkTaskInput, nextOccurrence, previewSchedule } from "./schedule.js";
import { TaskProcess } from "./process.js";
import { TaskOutputs } from "./outputs.js";
import { taskRecord, type TaskRecord } from "./record.js";

type SkipReason = "missed" | "overlap" | "capacity";

function removableRuns(record: TaskRecord) {
  return record.runs.filter(
    (run) => !taskRunActive(run.state) && run.id !== record.task.reviewRunId,
  );
}

function skipRun(run: TaskRun, reason: SkipReason) {
  run.state = "skipped";
  run.reasonCode = reason;
  run.endedAt = new Date().toISOString();
}

export class ScheduledTasks {
  private readonly directory: string;
  private readonly outputs: TaskOutputs;
  private readonly records = new Map<string, TaskRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly executions = new Map<
    string,
    { process: TaskProcess; finished: Promise<void> }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private loadError?: string;
  private readonly pending = new Map<string, string>();
  private readonly retentionErrors = new Map<string, string>();
  private readonly startupCleanupErrors: string[] = [];
  private revision = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly onChange: (snapshot: TaskSnapshot) => void,
  ) {
    this.directory = join(config.dataDir, stateFiles.tasks);
    this.outputs = new TaskOutputs(
      this.directory,
      config.limits.taskOutputBytes,
      config.limits.taskOutputTotalBytes,
    );
  }

  private statePath(id: string) {
    return join(this.directory, `${id}.json`);
  }

  private serial<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.queue.then(() => {
      signal?.throwIfAborted();
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  assertAvailable() {
    if (this.loadError) throw new AppError("io_error", "Scheduled task storage is unavailable");
  }

  private writable() {
    if (this.closing) throw new AppError("cancelled", "Agent is stopping");
  }

  private record(id: string) {
    const record = this.records.get(id);
    if (!record) throw new AppError("not_found", "Scheduled task does not exist");
    return record;
  }

  private findRun(id: string) {
    for (const record of this.records.values()) {
      const run = record.runs.find((item) => item.id === id);
      if (run) return { record, run };
    }
    throw new AppError("not_found", "Run does not exist or has been cleaned up");
  }

  private async persistCandidateThenPublish(record: TaskRecord) {
    await atomicJson(this.statePath(record.task.id), record);
    this.pending.delete(record.task.id);
    this.retentionErrors.delete(record.task.id);
    this.publishRecordAndNotify(record);
  }

  private publishRecordAndNotify(record: TaskRecord) {
    this.records.set(record.task.id, record);
    this.notify();
  }

  private notify() {
    this.revision++;
    try {
      this.onChange(this.snapshot());
    } catch (error) {
      console.error("Scheduled task notification:", asError(error).message);
    }
  }

  private async persistFactsAndPublish(record: TaskRecord) {
    try {
      await this.persistCandidateThenPublish(record);
    } catch (error) {
      const detail = asError(error);
      this.pending.set(record.task.id, detail.message);
      this.publishRecordAndNotify(record);
      console.error("Scheduled task facts not persisted:", record.task.id, detail.message);
      return detail;
    }
  }

  private occupiedRuns() {
    return new Set([
      ...this.executions.keys(),
      ...[...this.records.values()].flatMap(({ task, runs }) => [
        ...(task.reviewRunId ? [task.reviewRunId] : []),
        ...runs.filter((run) => taskRunActive(run.state)).map((run) => run.id),
      ]),
    ]);
  }

  private async attemptRetention(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      console.error("Scheduled task retention:", asError(error).message);
    }
  }

  async load() {
    let files: string[];
    const candidates: TaskRecord[] = [];
    let scannedOutputs: Awaited<ReturnType<TaskOutputs["load"]>>;
    let source: string | undefined = this.directory;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      files = await readdir(this.directory);
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        source = join(this.directory, file);
        if (!(await lstat(source)).isFile()) throw new Error("Task state is not a regular file");
        candidates.push(taskRecord(await readJson(source), file));
      }
      source = undefined;
      scannedOutputs = await this.outputs.load(files);
      // Normalize every candidate before saving records or removing any files.
      for (const record of candidates) {
        source = this.statePath(record.task.id);
        for (const run of record.runs) {
          const output = scannedOutputs.get(run.id);
          for (const key of ["stdoutBytes", "stderrBytes"] as const) {
            const bytes = output?.[key] ?? 0;
            if (bytes < run.output[key]) run.output.truncated = true;
            run.output[key] = bytes;
          }
          if (taskRunActive(run.state)) {
            run.state = "unknown";
            run.reasonCode = "unconfirmed";
            run.endedAt = new Date().toISOString();
            record.task.state = "paused";
            record.task.reviewRunId = run.id;
            record.task.revision++;
          }
        }
        this.recordMissedOnce(record);
        this.updateNextRunTime(record);
      }
    } catch (error) {
      this.loadError = source ? `${source}: ${asError(error).message}` : asError(error).message;
      console.error("Scheduled task storage:", this.loadError);
      return;
    }
    for (const candidate of candidates) this.records.set(candidate.task.id, candidate);
    for (const record of candidates) {
      await this.persistFactsAndPublish(record);
      await this.attemptRetention(() => this.pruneHistory(record.task.id));
    }
    // A crash can leave an unpublished atomic file or output whose record was already removed.
    const retained = new Set(
      [...this.records.values()].flatMap((item) => item.runs.map((run) => run.id)),
    );
    for (const file of files.filter((name) => name.endsWith(".tmp"))) {
      try {
        await rm(join(this.directory, file), { force: true });
      } catch (error) {
        const detail = `${file} startup cleanup failed: ${asError(error).message}`;
        this.startupCleanupErrors.push(detail);
        console.error("Scheduled task startup cleanup:", detail);
      }
    }
    for (const id of scannedOutputs.keys()) {
      if (!retained.has(id)) this.outputs.markResidual(id);
    }
    await this.outputs.removeResiduals();
    for (const record of this.records.values()) this.armTimer(record);
  }

  status() {
    return {
      loadError: this.loadError,
      failures: [
        ...[...this.pending].map(([id, error]) => `${id} not persisted: ${error}`),
        ...[...this.retentionErrors].map(([id, error]) => `${id} retention failed: ${error}`),
        ...this.outputs.diagnostics(),
        ...this.startupCleanupErrors,
      ],
      tasks: this.records.size,
      active: this.executions.size,
      needsReview: [...this.records.values()].filter((item) => item.task.reviewRunId).length,
    };
  }

  private summary(record: TaskRecord): ScheduledTaskSummary {
    const current = record.runs.find((run) => taskRunActive(run.state));
    const latest = record.runs.at(-1);
    return taskSummary({ ...record.task, currentRun: current, latestRun: latest });
  }

  snapshot(): TaskSnapshot {
    if (this.loadError) return { revision: this.revision, storageError: true, items: [] };
    return {
      revision: this.revision,
      items: [...this.records.values()].map((item) => this.summary(item)),
    };
  }

  list(offset = 0) {
    const items = this.snapshot().items;
    return {
      items: items.slice(offset, offset + taskLimits.pageEntries),
      offset,
      total: items.length,
    };
  }
  get(id: string) {
    return structuredClone(this.record(id).task);
  }
  listRuns(id: string, offset = 0) {
    const runs = this.record(id).runs.toReversed();
    return {
      items: runs.slice(offset, offset + taskLimits.pageEntries).map(taskRunSummary),
      offset,
      total: runs.length,
    };
  }
  getRun(id: string): TaskRun {
    const run = structuredClone(this.findRun(id).run);
    const active = this.executions.get(id);
    if (active) run.output = { ...active.process.output };
    return run;
  }

  create(id: string, input: unknown, signal: AbortSignal) {
    return this.serial(async () => {
      this.writable();
      if ([...this.records.keys()].some((existing) => existing.toLowerCase() === id.toLowerCase()))
        throw new AppError("conflict", "Scheduled task ID already exists");
      if (this.records.size >= this.config.limits.tasksPerDevice)
        throw new AppError("limit_exceeded", "Scheduled task count exceeds the device limit");
      const parameters = await checkTaskInput(input);
      previewSchedule(parameters.schedule, parameters.timezone);
      const record: TaskRecord = {
        task: {
          ...parameters,
          id,
          revision: 1,
          state: "active",
          nextRunAt: null,
          ...(parameters.schedule.kind === "once" ? { onceStatus: "pending" as const } : {}),
        },
        runs: [],
      };
      this.updateNextRunTime(record);
      signal.throwIfAborted();
      await this.persistCandidateThenPublish(record);
      this.armTimer(record);
      return this.get(id);
    }, signal);
  }

  update(
    id: string,
    expectedRevision: number,
    changes: Partial<ScheduledTaskInput>,
    signal: AbortSignal,
  ) {
    return this.serial(async () => {
      this.writable();
      const record = structuredClone(this.record(id));
      if (record.task.revision !== expectedRevision)
        throw new AppError("conflict", "Scheduled task changed; read it again before updating");
      const parameters = await checkTaskInput(
        { ...taskInput(record.task), ...changes },
        record.task.cwd,
      );
      if (
        changes.schedule !== undefined ||
        (changes.timezone !== undefined && parameters.schedule.kind === "cron")
      ) {
        previewSchedule(parameters.schedule, parameters.timezone);
        record.lastScheduledAt = undefined;
        record.task.onceStatus = parameters.schedule.kind === "once" ? "pending" : undefined;
      }
      Object.assign(record.task, parameters);
      return this.commitDefinition(record, signal);
    }, signal);
  }

  setPaused(id: string, paused: boolean, signal: AbortSignal) {
    return this.serial(async () => {
      this.writable();
      const record = structuredClone(this.record(id));
      if (!paused && record.task.reviewRunId)
        throw new AppError("conflict", "Acknowledge the unfinished run before resuming", {
          reviewRunId: record.task.reviewRunId,
        });
      record.task.state = paused ? "paused" : "active";
      return this.commitDefinition(record);
    }, signal);
  }

  acknowledge(id: string, runId: string, signal: AbortSignal) {
    return this.serial(async () => {
      this.writable();
      const record = structuredClone(this.record(id));
      if (record.task.reviewRunId !== runId)
        throw new AppError("conflict", "The pending review changed; read the current run ID", {
          reviewRunId: record.task.reviewRunId,
        });
      record.task.reviewRunId = undefined;
      record.task.state = "paused";
      return this.commitDefinition(record);
    }, signal);
  }

  private async commitDefinition(record: TaskRecord, signal?: AbortSignal) {
    record.task.revision++;
    this.recordMissedOnce(record);
    this.updateNextRunTime(record);
    signal?.throwIfAborted();
    await this.persistCandidateThenPublish(record);
    await this.attemptRetention(() => this.pruneHistory(record.task.id));
    this.armTimer(record);
    return this.get(record.task.id);
  }

  delete(id: string, acknowledgeRunId: string | undefined, signal: AbortSignal) {
    return this.serial(async () => {
      this.writable();
      const record = this.record(id);
      if (record.runs.some((run) => taskRunActive(run.state) || this.executions.has(run.id)))
        throw new AppError("busy", "Stop the current run before deleting this task");
      if (
        (record.task.reviewRunId || acknowledgeRunId) &&
        acknowledgeRunId !== record.task.reviewRunId
      )
        throw new AppError("conflict", "Acknowledge the unfinished run before deleting this task", {
          reviewRunId: record.task.reviewRunId,
        });
      await rm(this.statePath(id));
      this.pending.delete(id);
      this.retentionErrors.delete(id);
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.records.delete(id);
      this.notify();
      try {
        for (const run of record.runs) this.outputs.markResidual(run.id);
        for (const run of record.runs) await this.outputs.remove(run.id);
      } catch (error) {
        throw OperationError.from(asError(error), "partial", { removed: true });
      }
      return { removed: true as const };
    }, signal);
  }

  private updateNextRunTime(record: TaskRecord) {
    const task = record.task;
    const after = new Date(Math.max(Date.now(), Date.parse(record.lastScheduledAt ?? "") || 0));
    task.nextRunAt =
      task.state === "active" &&
      !task.reviewRunId &&
      (task.schedule.kind === "cron" || task.onceStatus === "pending")
        ? (nextOccurrence(task.schedule, task.timezone, after)?.toISOString() ?? null)
        : null;
  }

  private armTimer(record: TaskRecord) {
    const { id, revision, nextRunAt } = record.task;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.closing || !nextRunAt) return;
    const milliseconds = Math.max(0, Date.parse(nextRunAt) - Date.now());
    const timer = setTimeout(
      () => {
        void this.serial(() => this.handleScheduledOccurrence(id, revision, nextRunAt)).catch(
          (error: unknown) => console.error("Scheduled task:", asError(error).message),
        );
      },
      Math.min(milliseconds, agentLimits.maxTimerDelay),
    );
    this.timers.set(id, timer);
  }

  private async handleScheduledOccurrence(id: string, revision: number, scheduledAt: string) {
    const latest = this.records.get(id);
    if (
      !latest ||
      latest.task.revision !== revision ||
      latest.task.nextRunAt !== scheduledAt ||
      this.closing
    )
      return;
    if (Date.now() < Date.parse(scheduledAt)) {
      this.armTimer(latest);
      return;
    }
    try {
      await this.startScheduledRun(id, randomUUID(), scheduledAt);
    } catch (error) {
      console.error("Scheduled task admission:", asError(error).message);
      const current = structuredClone(this.record(id));
      if (current.task.nextRunAt !== scheduledAt) return;
      current.lastScheduledAt = scheduledAt;
      this.recordMissedOnce(current);
      this.updateNextRunTime(current);
      await this.persistFactsAndPublish(current);
      this.armTimer(current);
    }
  }

  private newRun(record: TaskRecord, id: string, scheduledAt?: string): TaskRun {
    return {
      id,
      taskId: record.task.id,
      trigger: scheduledAt ? "scheduled" : "manual",
      scheduledAt,
      acceptedAt: new Date().toISOString(),
      state: "starting",
      parameters: { ...taskInput(record.task), taskRevision: record.task.revision },
      output: { stdoutBytes: 0, stderrBytes: 0, truncated: false },
    };
  }

  private recordMissedOnce(record: TaskRecord) {
    if (
      record.task.schedule.kind !== "once" ||
      record.task.onceStatus !== "pending" ||
      Date.parse(record.task.schedule.at) > Date.now()
    )
      return;
    record.task.onceStatus = "missed";
    const run = this.newRun(record, randomUUID(), record.task.schedule.at);
    skipRun(run, "missed");
    record.runs.push(run);
  }

  start(id: string, runId: string, signal: AbortSignal) {
    return this.serial(async () => {
      const record = this.recordForAdmission(id, runId);
      const run = this.newRun(record, runId);
      const reason = this.runBlockReason(record);
      if (reason === "overlap") throw new AppError("busy", "Task is already running");
      if (reason === "capacity")
        throw new AppError("busy", "Device task concurrency limit reached");

      const prepared = await this.prepareStorageForRun(id);
      prepared.runs.push(run);
      await this.persistCandidateThenPublish(prepared);
      return this.spawnAndPersistStartFacts(run);
    }, signal);
  }

  private recordForAdmission(id: string, runId: string) {
    this.writable();
    const record = structuredClone(this.record(id));
    if (record.task.reviewRunId)
      throw new AppError("busy", "Review the unfinished run before starting another", {
        reviewRunId: record.task.reviewRunId,
      });
    const key = runId.toLowerCase();
    if (
      this.outputs.hasResidualId(runId) ||
      [...this.records.values()].some((item) =>
        item.runs.some((run) => run.id.toLowerCase() === key),
      )
    )
      throw new AppError("conflict", "Run ID already exists; query that run");
    return record;
  }

  private runBlockReason(record: TaskRecord): "overlap" | "capacity" | undefined {
    if (record.runs.some((run) => taskRunActive(run.state))) return "overlap";
    if (this.occupiedRuns().size >= this.config.limits.taskRunsPerDevice) return "capacity";
  }

  private async prepareStorageForRun(id: string) {
    await this.outputs.removeResiduals();
    await this.pruneHistory(id);
    await this.makeOutputRoom();
    // Retention may have published a shorter history; keep the original acceptance snapshot.
    return structuredClone(this.record(id));
  }

  private async startScheduledRun(id: string, runId: string, scheduledAt: string) {
    const record = this.recordForAdmission(id, runId);
    const run = this.newRun(record, runId, scheduledAt);
    const reason =
      Date.now() - Date.parse(scheduledAt) > taskLimits.lateToleranceMs
        ? "missed"
        : this.runBlockReason(record);
    if (reason) {
      this.consumeScheduledOccurrence(record, scheduledAt, reason);
      skipRun(run, reason);
      record.runs.push(run);
      this.updateNextRunTime(record);
      await this.persistFactsAndPublish(record);
      this.armTimer(record);
      await this.attemptRetention(() => this.pruneHistory(id));
      return;
    }

    const prepared = await this.prepareStorageForRun(id);
    this.consumeScheduledOccurrence(prepared, scheduledAt);
    prepared.runs.push(run);
    this.updateNextRunTime(prepared);
    await this.persistCandidateThenPublish(prepared);
    this.armTimer(prepared);
    await this.spawnAndPersistStartFacts(run);
  }

  private consumeScheduledOccurrence(record: TaskRecord, scheduledAt: string, reason?: SkipReason) {
    record.lastScheduledAt = scheduledAt;
    if (record.task.schedule.kind === "once")
      record.task.onceStatus = reason === "missed" ? "missed" : "consumed";
  }

  private async spawnAndPersistStartFacts(run: TaskRun) {
    const id = run.taskId;
    const runId = run.id;
    let process: TaskProcess;
    try {
      process = await TaskProcess.start(this.config.shell, run, this.outputs.forRun(runId));
    } catch (error) {
      const failed = structuredClone(this.record(id));
      const saved = failed.runs.find((item) => item.id === runId)!;
      Object.assign(saved, {
        state: "failed",
        reasonCode: "start_failed",
        endedAt: new Date().toISOString(),
        diagnostic: asError(error).message,
        exitCode: null,
      });
      await this.persistFactsAndPublish(failed);
      await this.attemptRetention(() => this.pruneHistory(id));
      return this.getRun(runId);
    }
    const finished = this.finishRun(id, runId, process);
    this.executions.set(runId, { process, finished });
    const started = structuredClone(this.record(id));
    const saved = started.runs.find((item) => item.id === runId)!;
    if (process.pid) {
      saved.state = "running";
      saved.startedAt = new Date().toISOString();
    } else {
      saved.state = "starting";
    }
    saved.pid = process.pid;
    const detail = await this.persistFactsAndPublish(started);
    if (detail) {
      throw OperationError.from(detail, "unknown", { taskId: id, runId });
    }
    return this.getRun(runId);
  }

  private async finishRun(id: string, runId: string, process: TaskProcess) {
    try {
      const result = await process.done;
      await this.serial(async () => {
        const latest = structuredClone(this.record(id));
        const saved = latest.runs.find((item) => item.id === runId)!;
        Object.assign(saved, result, {
          output: { ...process.output },
          endedAt: new Date().toISOString(),
        });
        if (process.stopReason) {
          saved.state = "stopped";
          saved.reasonCode = process.stopReason;
        } else {
          if (result.exitCode === 0) saved.state = "succeeded";
          else saved.state = "failed";
          if (!process.pid && result.diagnostic) saved.reasonCode = "start_failed";
          else if (result.exitCode !== 0) saved.reasonCode = "exit_nonzero";
          else saved.reasonCode = undefined;
        }
        await this.persistFactsAndPublish(latest);
        await this.attemptRetention(() => this.pruneHistory(id));
      });
    } catch (error) {
      console.error("Scheduled task result:", asError(error).message);
    } finally {
      this.executions.delete(runId);
    }
  }

  stop(id: string, signal: AbortSignal) {
    return this.serial(async () => {
      const record = structuredClone(this.findRun(id).record);
      const run = record.runs.find((item) => item.id === id)!;
      const active = this.executions.get(id);
      if (!active || !taskRunActive(run.state)) return this.getRun(id);
      run.state = "stopping";
      const stopped = active.process.stop("requested_stop");
      void stopped.catch((error: unknown) =>
        console.error("Scheduled task stop:", asError(error).message),
      );
      const detail = await this.persistFactsAndPublish(record);
      if (detail) {
        throw OperationError.from(detail, "unknown", { runId: id });
      }
      return this.getRun(id);
    }, signal);
  }

  async output(
    id: string,
    stream: "stdout" | "stderr",
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<TaskOutput> {
    signal.throwIfAborted();
    const run = this.getRun(id);
    const output = await this.outputs.read({
      id,
      stream,
      offset,
      limit,
      finished: !taskRunActive(run.state),
      signal,
    });
    return { ...output, truncated: run.output.truncated };
  }

  private async persistRunRemovalThenDeleteOutput(task: string, id: string) {
    const record = structuredClone(this.record(task));
    record.runs = record.runs.filter((run) => run.id !== id);
    try {
      await this.persistCandidateThenPublish(record);
    } catch (error) {
      this.retentionErrors.set(task, asError(error).message);
      throw error;
    }
    await this.outputs.remove(id);
  }

  private async pruneHistory(id: string) {
    const ended = removableRuns(this.record(id));
    for (const run of ended.slice(
      0,
      Math.max(0, ended.length - this.config.limits.taskHistoryRuns),
    ))
      await this.persistRunRemovalThenDeleteOutput(id, run.id);
  }

  private async makeOutputRoom() {
    const ended = [...this.records.values()].flatMap(removableRuns);
    const target = Math.min(
      this.config.limits.taskOutputBytes,
      this.config.limits.taskOutputTotalBytes,
    );
    const reclaimable = ended.reduce((bytes, run) => bytes + this.outputs.bytes(run.id), 0);
    if (this.outputs.totalBytes - reclaimable + target > this.config.limits.taskOutputTotalBytes)
      return;
    ended.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    for (const run of ended) {
      if (this.outputs.totalBytes + target <= this.config.limits.taskOutputTotalBytes) break;
      if (!this.outputs.bytes(run.id)) continue;
      await this.persistRunRemovalThenDeleteOutput(run.taskId, run.id);
    }
  }

  beginClose() {
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  async close() {
    this.beginClose();
    await this.queue;
    const running = [...this.executions.values()];
    const stops = await Promise.allSettled(running.map((item) => item.process.stop("agent_stop")));
    await Promise.all(running.map((item) => item.finished));
    await this.queue;
    const failure = stops.find((item) => item.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (this.pending.size)
      throw new AppError("io_error", "Some scheduled task facts were not persisted", {
        tasks: [...this.pending.keys()],
      });
  }
}
