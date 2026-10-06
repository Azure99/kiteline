import { agentLimits, taskLimits } from "../limits.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  OperationError,
  asError,
  taskRunActive,
  taskRunSummary,
  type ScheduledTaskInput,
  type ScheduledTaskSummary,
  type TaskOutput,
  type TaskRun,
  type TaskSnapshot,
} from "@kiteline/shared/protocol";
import { atomicJson, readJson, stateFiles, type AgentConfig } from "../config.js";
import { checkTaskInput, nextOccurrence, previewSchedule } from "./schedule.js";
import { TaskProcess } from "./process.js";
import { taskRecord, type TaskRecord } from "./record.js";

const outputSuffix = /\.(stdout|stderr)$/;

function outputName(id: string, stream: "stdout" | "stderr") {
  return `${id}.${stream}`;
}

function removableRuns(record: TaskRecord) {
  return record.runs.filter(
    (run) => !taskRunActive(run.state) && run.id !== record.task.reviewRunId,
  );
}

function skipRun(run: TaskRun, reason: "missed" | "overlap" | "capacity") {
  run.state = "skipped";
  run.reasonCode = reason;
  run.endedAt = new Date().toISOString();
}

export class ScheduledTasks {
  private readonly directory: string;
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
  private readonly residuals = new Set<string>();
  private readonly outputSizes = new Map<string, number>();
  private cleanupError?: string;
  private revision = 0;
  private outputBytes = 0;
  onChange?: (snapshot: TaskSnapshot) => void;

  constructor(private readonly config: AgentConfig) {
    this.directory = join(config.dataDir, stateFiles.tasks);
  }

  private statePath(id: string) {
    return join(this.directory, `${id}.json`);
  }
  private outputPath(id: string, stream: "stdout" | "stderr") {
    return join(this.directory, outputName(id, stream));
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

  private async save(record: TaskRecord) {
    await atomicJson(this.statePath(record.task.id), record);
    this.pending.delete(record.task.id);
    this.publish(record);
  }

  private publish(record: TaskRecord) {
    this.records.set(record.task.id, record);
    this.notify();
  }

  private notify() {
    this.revision++;
    try {
      this.onChange?.(this.snapshot());
    } catch (error) {
      console.error("Scheduled task notification:", asError(error).message);
    }
  }

  private async saveKnown(record: TaskRecord) {
    try {
      await this.save(record);
    } catch (error) {
      const detail = asError(error);
      this.pending.set(record.task.id, detail.message);
      this.publish(record);
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

  private outputSize(id: string, delta: number) {
    this.outputBytes += delta;
    const size = (this.outputSizes.get(id) ?? 0) + delta;
    if (size) this.outputSizes.set(id, size);
    else this.outputSizes.delete(id);
  }

  private async cleanup(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      this.cleanupError = asError(error).message;
      console.error("Scheduled task retention:", this.cleanupError);
    }
  }

  async load() {
    let files: string[];
    const candidates: TaskRecord[] = [];
    const outputSizes = new Map<string, number>();
    let source = this.directory;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      files = await readdir(this.directory);
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        source = join(this.directory, file);
        if (!(await lstat(source)).isFile()) throw new Error("Task state is not a regular file");
        candidates.push(taskRecord(await readJson(source), file));
      }
      for (const file of files.filter((name) => outputSuffix.test(name))) {
        source = join(this.directory, file);
        if (!(await lstat(source)).isFile()) throw new Error("Output is not a regular file");
        const output = await open(source, "r");
        try {
          outputSizes.set(file, (await output.stat()).size);
        } finally {
          await output.close();
        }
      }
      // Normalize every candidate before saving records or removing any files.
      for (const record of candidates) {
        source = this.statePath(record.task.id);
        for (const run of record.runs) {
          for (const stream of ["stdout", "stderr"] as const) {
            const key = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
            const bytes = outputSizes.get(outputName(run.id, stream)) ?? 0;
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
        await this.expireOnce(record);
        this.nextTime(record);
      }
    } catch (error) {
      this.loadError = `${source}: ${asError(error).message}`;
      console.error("Scheduled task storage:", this.loadError);
      return;
    }
    for (const [file, bytes] of outputSizes) {
      const id = file.replace(outputSuffix, "");
      this.outputSize(id, bytes);
    }
    for (const candidate of candidates) this.records.set(candidate.task.id, candidate);
    for (const record of candidates) {
      await this.saveKnown(record);
      await this.cleanup(() => this.prune(record.task.id));
    }
    // A crash can leave an unpublished atomic file or output whose record was already removed.
    const retained = new Set(
      [...this.records.values()].flatMap((item) => item.runs.map((run) => run.id)),
    );
    for (const file of files) {
      if (file.endsWith(".tmp"))
        await this.cleanup(() => rm(join(this.directory, file), { force: true }));
      if (outputSuffix.test(file)) {
        const id = file.replace(outputSuffix, "");
        if (!retained.has(id)) this.residuals.add(id);
      }
    }
    await this.cleanup(() => this.cleanResiduals());
    for (const record of this.records.values()) this.arm(record);
  }

  status() {
    const storageError =
      [
        this.loadError,
        ...[...this.pending].map(([id, error]) => `${id} not persisted: ${error}`),
        this.cleanupError,
      ]
        .filter(Boolean)
        .join("; ") || undefined;
    return {
      ready: !this.closing && !storageError,
      storageError,
      tasks: this.records.size,
      active: this.executions.size,
      needsReview: [...this.records.values()].filter((item) => item.task.reviewRunId).length,
    };
  }

  private summary(record: TaskRecord): ScheduledTaskSummary {
    const { id, name, state, reviewRunId, nextRunAt, onceStatus } = record.task;
    const current = record.runs.find((run) => taskRunActive(run.state));
    const latest = record.runs.at(-1);
    return {
      id,
      name,
      state,
      reviewRunId,
      nextRunAt,
      onceStatus,
      currentRun: current && taskRunSummary(current),
      latestRun: latest && taskRunSummary(latest),
    };
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
      this.nextTime(record);
      signal.throwIfAborted();
      await this.save(record);
      this.arm(record);
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
      const { name, command, cwd, timezone, schedule } = record.task;
      const parameters = await checkTaskInput(
        {
          name,
          command,
          cwd,
          timezone,
          schedule,
          ...changes,
        },
        cwd,
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
    await this.expireOnce(record);
    this.nextTime(record);
    signal?.throwIfAborted();
    await this.save(record);
    await this.cleanup(() => this.prune(record.task.id));
    this.arm(record);
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
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.records.delete(id);
      this.notify();
      try {
        for (const run of record.runs) this.residuals.add(run.id);
        for (const run of record.runs) await this.removeOutput(run.id);
      } catch (error) {
        throw OperationError.from(asError(error), "partial", { removed: true });
      }
      return { removed: true as const };
    }, signal);
  }

  private nextTime(record: TaskRecord) {
    const task = record.task;
    const after = new Date(Math.max(Date.now(), Date.parse(record.lastScheduledAt ?? "") || 0));
    task.nextRunAt =
      task.state === "active" &&
      !task.reviewRunId &&
      (task.schedule.kind === "cron" || task.onceStatus === "pending")
        ? (nextOccurrence(task.schedule, task.timezone, after)?.toISOString() ?? null)
        : null;
  }

  private arm(record: TaskRecord) {
    const { id, revision, nextRunAt } = record.task;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.closing || !nextRunAt) return;
    const milliseconds = Math.max(0, Date.parse(nextRunAt) - Date.now());
    const timer = setTimeout(
      () => {
        void this.serial(async () => {
          const latest = this.records.get(id);
          if (
            !latest ||
            latest.task.revision !== revision ||
            latest.task.nextRunAt !== nextRunAt ||
            this.closing
          )
            return;
          if (Date.now() < Date.parse(nextRunAt)) {
            this.arm(latest);
            return;
          }
          try {
            await this.admit(id, randomUUID(), nextRunAt);
          } catch (error) {
            console.error("Scheduled task admission:", asError(error).message);
            const current = structuredClone(this.record(id));
            if (current.task.nextRunAt === nextRunAt) {
              current.lastScheduledAt = nextRunAt;
              await this.expireOnce(current);
              this.nextTime(current);
              await this.saveKnown(current);
              this.arm(current);
            }
          }
        }).catch((error: unknown) => console.error("Scheduled task:", asError(error).message));
      },
      Math.min(milliseconds, agentLimits.maxTimerDelay),
    );
    this.timers.set(id, timer);
  }

  private newRun(record: TaskRecord, id: string, scheduledAt?: string): TaskRun {
    const { name, command, cwd, schedule, timezone, revision } = record.task;
    return {
      id,
      taskId: record.task.id,
      trigger: scheduledAt ? "scheduled" : "manual",
      scheduledAt,
      acceptedAt: new Date().toISOString(),
      state: "starting",
      parameters: { name, command, cwd, schedule, timezone, taskRevision: revision },
      output: { stdoutBytes: 0, stderrBytes: 0, truncated: false },
    };
  }

  private async expireOnce(record: TaskRecord) {
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
    return this.serial(() => this.admit(id, runId), signal);
  }

  private async admit(id: string, runId: string, scheduledAt?: string): Promise<TaskRun> {
    this.writable();
    let record = structuredClone(this.record(id));
    if (record.task.reviewRunId)
      throw new AppError("busy", "Review the unfinished run before starting another", {
        reviewRunId: record.task.reviewRunId,
      });
    const key = runId.toLowerCase();
    if (
      [...this.residuals].some((id) => id.toLowerCase() === key) ||
      [...this.records.values()].some((item) =>
        item.runs.some((run) => run.id.toLowerCase() === key),
      )
    )
      throw new AppError("conflict", "Run ID already exists; query that run");
    const run = this.newRun(record, runId, scheduledAt);
    const reason =
      scheduledAt && Date.now() - Date.parse(scheduledAt) > taskLimits.lateToleranceMs
        ? "missed"
        : record.runs.some((item) => taskRunActive(item.state))
          ? "overlap"
          : this.occupiedRuns().size >= this.config.limits.taskRunsPerDevice
            ? "capacity"
            : undefined;
    if (reason && !scheduledAt)
      throw new AppError(
        "busy",
        reason === "overlap" ? "Task is already running" : "Device task concurrency limit reached",
      );
    if (!reason) {
      await this.cleanResiduals();
      await this.prune(id);
      await this.makeOutputRoom();
      record = structuredClone(this.record(id));
    }
    if (scheduledAt) {
      record.lastScheduledAt = scheduledAt;
      if (record.task.schedule.kind === "once")
        record.task.onceStatus = reason === "missed" ? "missed" : "consumed";
    }
    if (reason) skipRun(run, reason);
    record.runs.push(run);
    if (scheduledAt) this.nextTime(record);
    await this.save(record);
    if (scheduledAt) this.arm(record);
    if (reason) {
      await this.cleanup(() => this.prune(id));
      return structuredClone(run);
    }
    let process: TaskProcess;
    try {
      process = await TaskProcess.start(
        this.config.shell,
        run,
        (stream) => this.outputPath(runId, stream),
        (wanted) => {
          const bytes = Math.min(
            wanted,
            Math.max(0, this.config.limits.taskOutputTotalBytes - this.outputBytes),
          );
          this.outputSize(runId, bytes);
          return bytes;
        },
        (bytes) => {
          this.outputSize(runId, -bytes);
        },
        this.config.limits.taskOutputBytes,
      );
    } catch (error) {
      Object.assign(run, {
        state: "failed",
        reasonCode: "start_failed",
        endedAt: new Date().toISOString(),
        diagnostic: asError(error).message,
        exitCode: null,
      });
      await this.saveKnown(record);
      return this.getRun(runId);
    }
    const finished = process.done
      .then((result) =>
        this.serial(async () => {
          const latest = structuredClone(this.record(id));
          const saved = latest.runs.find((item) => item.id === runId)!;
          Object.assign(saved, result, {
            output: { ...process.output },
            endedAt: new Date().toISOString(),
            state: process.stopReason ? "stopped" : result.exitCode === 0 ? "succeeded" : "failed",
            reasonCode:
              process.stopReason ??
              (!process.pid && result.diagnostic
                ? "start_failed"
                : result.exitCode === 0
                  ? undefined
                  : "exit_nonzero"),
          });
          await this.saveKnown(latest);
          await this.cleanup(() => this.prune(id));
        }),
      )
      .catch((error: unknown) => {
        console.error("Scheduled task result:", asError(error).message);
      })
      .finally(() => this.executions.delete(runId));
    this.executions.set(runId, { process, finished });
    const started = structuredClone(this.record(id));
    const saved = started.runs.find((item) => item.id === runId)!;
    saved.state = process.pid ? "running" : "starting";
    if (process.pid) saved.startedAt = new Date().toISOString();
    saved.pid = process.pid;
    const detail = await this.saveKnown(started);
    if (detail) {
      throw OperationError.from(detail, "unknown", { taskId: id, runId });
    }
    return this.getRun(runId);
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
      const detail = await this.saveKnown(record);
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
    const finished = !taskRunActive(run.state);
    let file;
    try {
      file = await open(this.outputPath(id, stream), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        text: "",
        offset: 0,
        nextOffset: 0,
        storedBytes: 0,
        truncated: run.output.truncated,
        finished,
      };
    }
    try {
      const size = (await file.stat()).size;
      if (offset > size) offset = 0;
      const bytes = Buffer.alloc(Math.min(limit, size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      signal.throwIfAborted();
      const flush = finished && offset + bytesRead === size;
      let complete = bytesRead;
      if (!flush && bytesRead) {
        let start = bytesRead - 1;
        while (start > 0 && bytesRead - start < 4 && (bytes[start]! & 0xc0) === 0x80) start--;
        const first = bytes[start]!;
        const width =
          first >= 0xc2 && first <= 0xdf
            ? 2
            : first >= 0xe0 && first <= 0xef
              ? 3
              : first >= 0xf0 && first <= 0xf4
                ? 4
                : 1;
        if (bytesRead - start < width) complete = start;
      }
      return {
        text: bytes.subarray(0, complete).toString("utf8"),
        offset,
        nextOffset: offset + complete,
        storedBytes: size,
        truncated: run.output.truncated,
        finished,
      };
    } finally {
      await file.close();
    }
  }

  private async removeOutput(id: string) {
    this.residuals.add(id);
    for (const stream of ["stdout", "stderr"] as const) {
      const path = this.outputPath(id, stream);
      const bytes = await lstat(path).then(
        (info) => {
          if (!info.isFile()) throw new Error(`Task output is not a regular file: ${path}`);
          return info.size;
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      await rm(path, { force: true });
      this.outputSize(id, -Math.min(bytes, this.outputSizes.get(id) ?? 0));
    }
    this.outputSize(id, -(this.outputSizes.get(id) ?? 0));
    this.residuals.delete(id);
  }

  private async cleanResiduals() {
    for (const id of this.residuals) await this.cleanup(() => this.removeOutput(id));
    if (!this.residuals.size) this.cleanupError = undefined;
  }

  private async removeRun(task: string, id: string) {
    const record = structuredClone(this.record(task));
    record.runs = record.runs.filter((run) => run.id !== id);
    await this.save(record);
    await this.removeOutput(id);
  }

  private async prune(id: string) {
    const record = this.record(id);
    const ended = removableRuns(record);
    for (const run of ended.slice(
      0,
      Math.max(0, ended.length - this.config.limits.taskHistoryRuns),
    ))
      await this.removeRun(id, run.id);
  }

  private async makeOutputRoom() {
    const ended = [...this.records.values()].flatMap(removableRuns);
    const target = Math.min(
      this.config.limits.taskOutputBytes,
      this.config.limits.taskOutputTotalBytes,
    );
    const reclaimable = ended.reduce(
      (bytes, run) => bytes + (this.outputSizes.get(run.id) ?? 0),
      0,
    );
    if (this.outputBytes - reclaimable + target > this.config.limits.taskOutputTotalBytes) return;
    ended.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    for (const run of ended) {
      if (this.outputBytes + target <= this.config.limits.taskOutputTotalBytes) break;
      if (!this.outputSizes.get(run.id)) continue;
      await this.removeRun(run.taskId, run.id);
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
