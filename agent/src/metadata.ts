import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import {
  AppError,
  checkEnvironment,
  checkMetadata,
  limits,
  type AgentEnvironment,
  type Metadata,
} from "@kiteline/shared/protocol";
import { atomicJson, readJson, type AgentConfig } from "./config.js";
import { windowsNative } from "@kiteline/shared/windows/native";
import { devicePath, realPath, sameObject } from "./files/paths.js";
import { publicCliPath } from "./installation.js";

export class MetadataStore {
  value: Metadata = {
    schemaVersion: 1,
    revision: 0,
    workspaces: [],
    shortcuts: [
      { id: "claude", name: "Claude Code", command: "claude", icon: "sparkles" },
      { id: "codex", name: "Codex", command: "codex", icon: "code" },
      { id: "opencode", name: "OpenCode", command: "opencode", icon: "terminal" },
    ],
    settings: { historyLines: 10_000 },
  };
  onChange?: (snapshot: Metadata) => void;
  private queue: Promise<unknown> = Promise.resolve();
  readonly environment: AgentEnvironment;
  constructor(private config: AgentConfig) {
    const windows = process.platform === "win32" ? windowsNative().identity() : undefined;
    this.environment = checkEnvironment({
      os: windows ? "windows" : "linux",
      homePath: windows?.home ?? homedir(),
      rootPaths: windows?.roots ?? ["/"],
      cliPath: publicCliPath,
      dataDir: config.dataDir,
      runDir: config.runDir,
    });
  }
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
      snapshot,
      editorBytes: this.config.limits.editorBytes,
      environment: this.environment,
    };
  }
  private checkBudget(snapshot: Metadata) {
    for (const message of [this.hello(snapshot), { type: "metadata.snapshot", snapshot }])
      if (Buffer.byteLength(JSON.stringify(message)) > limits.controlMessageBytes)
        throw new AppError(
          "limit_exceeded",
          "Device registration information exceeds the control message size limit",
        );
  }
  update<T>(change: (candidate: Metadata) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted();
      const candidate = structuredClone(this.value);
      const result = await change(candidate);
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
    devicePath(absolutePath);
    return this.update(async (metadata) => {
      const path = await realPath(absolutePath);
      const info = await stat(path, { bigint: true });
      if (!info.isDirectory()) throw new AppError("invalid_argument", "Select a directory");
      for (const workspace of metadata.workspaces) {
        if (workspace.path === path) return workspace;
        // An inaccessible old registration must not block a valid new directory.
        const other = await stat(workspace.path, { bigint: true }).catch(() => undefined);
        if (other && sameObject(info, other)) return workspace;
      }
      signal?.throwIfAborted();
      const workspace = { id: randomUUID(), path, name: name ?? (basename(path) || path) };
      metadata.workspaces.push(workspace);
      return workspace;
    }, signal);
  }
  workspace(id: string) {
    const workspace = this.value.workspaces.find((w) => w.id === id);
    if (!workspace) throw new AppError("not_found", "Workspace does not exist");
    return workspace;
  }
}
