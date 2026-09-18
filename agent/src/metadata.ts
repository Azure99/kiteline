import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  AppError,
  appVersion,
  checkMetadata,
  limits,
  type Metadata,
} from "@kiteline/shared/protocol";
import { atomicJson, readJson, type AgentConfig } from "./config.js";

export class MetadataStore {
  value: Metadata = {
    schemaVersion: 1,
    revision: 0,
    workspaces: [],
    shortcuts: [],
    settings: { historyLines: 10_000 },
  };
  onChange?: (snapshot: Metadata) => void;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private config: AgentConfig) {}
  async load() {
    try {
      this.value = checkMetadata(await readJson(resolve(this.config.dataDir, "agent.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.checkBudget(this.value);
  }
  hello(snapshot = this.value) {
    return {
      type: "hello",
      protocolVersion: 1,
      agentVersion: appVersion,
      snapshot,
      editorBytes: this.config.limits.editorBytes,
    };
  }
  private checkBudget(snapshot: Metadata) {
    for (const message of [this.hello(snapshot), { type: "metadata.snapshot", snapshot }])
      if (Buffer.byteLength(JSON.stringify(message)) > limits.controlMessageBytes)
        throw new AppError("limit_exceeded", "设备登记信息超过控制消息容量");
  }
  update<T>(change: (candidate: Metadata) => T, signal?: AbortSignal): Promise<T> {
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted();
      const candidate = structuredClone(this.value);
      const result = change(candidate);
      candidate.revision++;
      this.checkBudget(candidate);
      await atomicJson(resolve(this.config.dataDir, "agent.json"), candidate);
      this.value = candidate;
      this.onChange?.(candidate);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  withCurrent<T>(read: (metadata: Metadata) => T): Promise<T> {
    const operation = this.queue.then(() => read(this.value));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async add(absolutePath: string, name?: string, signal?: AbortSignal) {
    if (!isAbsolute(absolutePath)) throw new AppError("invalid_argument", "需要绝对目录路径");
    const path = await realpath(absolutePath);
    if (!(await stat(path)).isDirectory()) throw new AppError("invalid_argument", "请选择目录");
    return this.update((metadata) => {
      const previous = metadata.workspaces.find((w) => w.path === path);
      if (previous) return previous;
      const workspace = { id: randomUUID(), path, name: name ?? (basename(path) || path) };
      metadata.workspaces.push(workspace);
      return workspace;
    }, signal);
  }
  workspace(id: string) {
    const workspace = this.value.workspaces.find((w) => w.id === id);
    if (!workspace) throw new AppError("not_found", "workspace 不存在");
    return workspace;
  }
}
