import { limits } from "@kiteline/shared/protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { AppError, OperationError } from "@kiteline/shared/protocol";
import type {
  CreateTerminal,
  RecorderCall,
  RecorderConfig,
  RecorderMessage,
  RecorderRequest,
  TerminalIdentity,
} from "@kiteline/shared/protocol/ipc";
import { JsonWriter, readLines } from "@kiteline/shared/protocol/stdio";
import { internalNodeEnvironment } from "@kiteline/shared/terminal/node";
import { spawnJob, type JobChild } from "@kiteline/shared/windows/job";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface Instance {
  ready: Promise<void>;
  done: Promise<void>;
  finish: () => void;
  finished: boolean;
  stopping: boolean;
  closing?: Promise<void>;
  child?: ChildProcessWithoutNullStreams;
  job?: JobChild;
  writer?: JsonWriter;
  pending: Map<string, Pending>;
  stderr: string;
}
export interface Creation {
  result: Promise<TerminalIdentity>;
  cancel: () => Promise<void>;
}

export class Recorder {
  private instance?: Instance;
  private closing?: Promise<void>;
  onMessage?: (message: RecorderMessage) => void;
  onExit?: (reason: string) => void;
  constructor(private config: RecorderConfig) {}
  get available() {
    return !!this.instance?.writer && !this.instance.stopping;
  }
  get pid() {
    return this.instance?.job?.pid ?? this.instance?.child?.pid;
  }
  private async ensure(): Promise<Instance> {
    if (this.closing) throw new AppError("cancelled", "Terminal recorder is closing");
    if (this.instance?.stopping) {
      await this.instance.done;
      return this.ensure();
    }
    if (!this.instance) {
      let finish!: () => void;
      const instance: Instance = {
        ready: Promise.resolve(),
        done: new Promise<void>((resolve) => (finish = resolve)),
        finish,
        finished: false,
        stopping: false,
        pending: new Map(),
        stderr: "",
      };
      this.instance = instance;
      instance.ready = this.launch(instance).catch((error: unknown) => {
        instance.stderr = error instanceof Error ? error.message : String(error);
        this.exited(instance);
        throw error;
      });
    }
    const instance = this.instance;
    await instance.ready;
    if (instance.stopping) throw new AppError("recording_unavailable", "Terminal recorder exited");
    return instance;
  }
  private async launch(instance: Instance) {
    const args = [
      resolve(import.meta.dirname, "../../../terminal-recorder/dist/main.js"),
      "--agent",
      JSON.stringify(this.config),
    ];
    let stdin;
    let stdout;
    let stderr;
    if (process.platform === "win32") {
      const job = await spawnJob(process.execPath, args, { env: internalNodeEnvironment() });
      instance.job = job;
      stdin = job.stdin!;
      stdout = job.stdout!;
      stderr = job.stderr!;
      const drained = Promise.all([
        finished(stdout, { writable: false, cleanup: true }),
        finished(stderr, { writable: false, cleanup: true }),
      ]);
      void drained.catch(() => {});
      void (async () => {
        await job.exited;
        instance.stopping = true;
        await job.stop();
        // A final reply can already be buffered when the leader exits.
        await drained;
      })()
        .catch((error: unknown) => {
          instance.stderr = String(error);
        })
        .finally(() => this.exited(instance));
    } else {
      const child = spawn(process.execPath, args, { stdio: "pipe" });
      instance.child = child;
      ({ stdin, stdout, stderr } = child);
      child.on("error", (error) => {
        instance.stderr = error.message;
      });
      child.on("close", () => this.exited(instance));
    }
    instance.writer = new JsonWriter(stdin);
    stderr.on("data", (data: Buffer) => {
      if (instance.stderr.length < 8192) instance.stderr += data.toString();
    });
    stdin.on("error", () => {});
    readLines(
      stdout,
      (line) => {
        if (this.instance !== instance) return;
        const message = JSON.parse(line.toString()) as RecorderMessage;
        if (message.type === "reply") {
          const pending = instance.pending.get(message.reply.id);
          if (pending) {
            instance.pending.delete(message.reply.id);
            clearTimeout(pending.timer);
            if (message.reply.outcome === "succeeded") pending.resolve(message.reply.result);
            else if (message.reply.outcome === "failed")
              pending.reject(new AppError(message.reply.error.code, message.reply.error.message));
            else
              pending.reject(
                new OperationError(
                  message.reply.error.code,
                  message.reply.error.message,
                  message.reply.outcome,
                  message.reply.result,
                ),
              );
          }
        } else this.onMessage?.(message);
      },
      (error) => {
        instance.stderr = error.message;
        void this.stop(instance, true).catch(console.error);
      },
    );
  }
  private exited(instance: Instance) {
    if (instance.finished) return;
    instance.finished = true;
    instance.stopping = true;
    instance.writer?.close();
    const reason = instance.stderr.trim() || "Terminal recorder exited";
    for (const pending of instance.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new OperationError("recording_unavailable", reason, "unknown"));
    }
    instance.pending.clear();
    if (this.instance === instance) {
      this.instance = undefined;
      this.onExit?.(reason);
    }
    instance.finish();
  }
  async request<T>(message: RecorderCall): Promise<T> {
    return this.call<T>(await this.ensure(), message);
  }
  create(message: CreateTerminal): Creation {
    const instance = this.ensure();
    const id = randomUUID();
    return {
      result: instance.then((owner) =>
        this.call<TerminalIdentity>(owner, { type: "create", ...message }, id),
      ),
      cancel: async () => {
        const owner = await instance.catch(() => undefined);
        if (!owner || owner.finished) return;
        try {
          await this.call(owner, {
            type: "cancelCreate",
            sessionId: message.sessionId,
            createId: id,
          });
        } catch {
          // Only this recorder's empty process set can replace its failed acknowledgement.
          await this.stop(owner, true);
        }
      },
    };
  }
  private call<T>(instance: Instance, message: RecorderCall, id = randomUUID()): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        instance.pending.delete(id);
        reject(
          new OperationError("timeout", "Recorder did not acknowledge the operation", "unknown"),
        );
      }, limits.channelPairTimeout);
      instance.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.write(instance, { ...message, id } as RecorderRequest);
      } catch (error) {
        clearTimeout(timer);
        instance.pending.delete(id);
        reject(error);
      }
    });
  }
  private write(instance: Instance, message: RecorderRequest) {
    if (instance.stopping || !instance.writer)
      throw new AppError("recording_unavailable", "Terminal recorder is unavailable");
    const owner = "attachmentId" in message ? message.attachmentId : undefined;
    if (!instance.writer.send(message, owner))
      throw new AppError("limit_exceeded", "Terminal IPC send backlog limit reached");
  }
  send(message: RecorderRequest) {
    if (!this.instance)
      throw new AppError("recording_unavailable", "Terminal recorder is unavailable");
    this.write(this.instance, message);
  }
  detach(sessionId: string, attachmentId: string) {
    this.instance?.writer?.discard(attachmentId);
    if (this.available) this.send({ type: "detach", sessionId, attachmentId });
  }
  private terminate(instance: Instance) {
    if (instance.job) instance.job.terminate();
    else instance.child?.kill("SIGKILL");
  }
  private stop(instance: Instance, force = false) {
    instance.stopping = true;
    if (force) this.terminate(instance);
    return (instance.closing ??= (async () => {
      await instance.ready.catch(() => {});
      if (instance.finished) return;
      const deadline = setTimeout(() => this.terminate(instance), limits.channelPairTimeout);
      instance.writer?.close();
      if (force) this.terminate(instance);
      else if (instance.job) instance.job.stdin!.end();
      else instance.child?.kill("SIGTERM");
      try {
        await instance.done;
      } finally {
        clearTimeout(deadline);
      }
    })());
  }
  close() {
    return (this.closing ??= this.instance ? this.stop(this.instance) : Promise.resolve());
  }
}
