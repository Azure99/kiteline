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
  type AgentControlMessage,
  type Metadata,
  type Shortcut,
} from "@kiteline/shared/protocol";
import { atomicJson, readJson, stateFiles, type AgentConfig } from "./config.js";
import { windowsNative } from "@kiteline/shared/windows/native";
import { devicePath, realPath, sameObject } from "./files/paths.js";
import { publicCliPath } from "./install/paths.js";

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
      os: windows ? "windows" : process.platform === "darwin" ? "macos" : "linux",
      homePath: windows?.home ?? homedir(),
      rootPaths: windows?.roots ?? ["/"],
      cliPath: publicCliPath,
      dataDir: config.dataDir,
      runDir: config.runDir,
    });
  }
  async load() {
    try {
      this.value = checkMetadata(await readJson(resolve(this.config.dataDir, stateFiles.metadata)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.checkBudget(this.value);
  }
  hello(snapshot = this.value): Extract<AgentControlMessage, { type: "hello" }> {
    return {
      type: "hello",
      snapshot,
      editorBytes: this.config.limits.editorBytes,
      environment: this.environment,
    };
  }
  private checkBudget(snapshot: Metadata) {
    for (const message of [
      this.hello(snapshot),
      { type: "metadata.snapshot", snapshot } satisfies AgentControlMessage,
    ])
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
      await atomicJson(resolve(this.config.dataDir, stateFiles.metadata), candidate);
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

  rename(id: string, name: string, signal?: AbortSignal) {
    return this.update((metadata) => {
      const workspace = metadata.workspaces.find((item) => item.id === id);
      if (!workspace) throw new AppError("not_found", "Workspace does not exist");
      workspace.name = name;
      return workspace;
    }, signal);
  }

  remove(id: string, hasSessions: () => boolean, signal?: AbortSignal) {
    this.workspace(id);
    return this.update((metadata) => {
      if (hasSessions())
        throw new AppError("busy", "End the terminal sessions in the workspace first");
      metadata.workspaces = metadata.workspaces.filter((item) => item.id !== id);
      return { removed: true };
    }, signal);
  }

  updateSettings(historyLines: number, signal?: AbortSignal) {
    return this.update((metadata) => {
      metadata.settings.historyLines = historyLines;
      return metadata.settings;
    }, signal);
  }

  putShortcut(input: Omit<Shortcut, "id"> & { id?: string }, signal?: AbortSignal) {
    const id = input.id ?? randomUUID();
    return this.update((metadata) => {
      const previous = metadata.shortcuts.find((item) => item.id === id);
      if (input.id !== undefined && !previous)
        throw new AppError("not_found", "Shortcut does not exist");
      const shortcut = { ...input, id };
      if (previous) Object.assign(previous, shortcut);
      else metadata.shortcuts.push(shortcut);
      return shortcut;
    }, signal);
  }

  removeShortcut(id: string, signal?: AbortSignal) {
    return this.update((metadata) => {
      metadata.shortcuts = metadata.shortcuts.filter((item) => item.id !== id);
      return { removed: true };
    }, signal);
  }
}
