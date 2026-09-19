import { watch, type FSWatcher } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { limits, type Repo, type Workspace } from "@kiteline/shared/protocol";

const excluded = new Set([".git", "node_modules", ".pnpm", ".venv", "dist", "build", "target"]);
const gitTrees = ["refs", "rebase-merge", "rebase-apply", "sequencer"];
interface Target {
  owners: Set<string>;
  identity: string;
}
interface Active {
  root: string;
  repos: Map<string, Repo>;
  recent: Set<string>;
}
interface Watched extends Target {
  watcher: FSWatcher;
}

export class WorkspaceWatches {
  private active = new Map<string, Active>();
  private entries = new Map<string, Watched>();
  private pending = new Set<string>();
  private errors = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private events?: NodeJS.Timeout;
  private generation = 0;
  private rebuilding?: Promise<void>;
  constructor(
    private capacity: number,
    private send: (event: unknown) => void,
  ) {}

  set(workspaces: Workspace[]) {
    const ids = new Set(workspaces.map((item) => item.id));
    for (const id of this.active.keys())
      if (!ids.has(id)) {
        this.active.delete(id);
        this.pending.delete(id);
        this.errors.delete(id);
      }
    for (const item of workspaces)
      if (!this.active.has(item.id))
        this.active.set(item.id, { root: item.path, repos: new Map(), recent: new Set() });
    for (const [path, item] of this.entries) {
      for (const id of item.owners) if (!ids.has(id)) item.owners.delete(id);
      if (!item.owners.size) {
        item.watcher.close();
        this.entries.delete(path);
      }
    }
    this.schedule();
  }
  repo(workspaceId: string, repo: Repo) {
    const active = this.active.get(workspaceId);
    if (!active) return;
    const previous = [...active.repos.values()].find((item) => item.rootPath === repo.rootPath);
    if (previous?.id === repo.id) return;
    if (previous) active.repos.delete(previous.id);
    active.repos.set(repo.id, repo);
    this.schedule();
  }
  listed(workspaceId: string, path: string) {
    const active = this.active.get(workspaceId);
    if (!active) return;
    active.recent.delete(path);
    active.recent.add(path);
    while (active.recent.size > this.capacity)
      active.recent.delete(active.recent.values().next().value!);
    this.schedule();
  }
  reposComplete(workspaceId: string, repoIds: Set<string>) {
    const active = this.active.get(workspaceId);
    if (!active) return;
    for (const id of active.repos.keys()) if (!repoIds.has(id)) active.repos.delete(id);
    this.schedule();
  }
  changed(workspaceId: string, immediate = false) {
    if (!this.active.has(workspaceId)) return;
    if (immediate) {
      this.pending.delete(workspaceId);
      this.emit(workspaceId);
      return;
    }
    this.pending.add(workspaceId);
    this.events ??= setTimeout(() => {
      this.events = undefined;
      for (const id of this.pending) this.emit(id);
      this.pending.clear();
    }, limits.watchDebounce);
  }
  private emit(workspaceId: string) {
    this.send({ type: "workspace.changed", workspaceId, scopes: ["files", "git", "repos"] });
  }
  private schedule() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.rebuilding) {
        this.schedule();
        return;
      }
      this.rebuilding = this.rebuild().finally(() => {
        this.rebuilding = undefined;
      });
    }, limits.watchDebounce);
  }
  private async rebuild() {
    const generation = this.generation;
    const desired = new Map<string, Target>();
    const metadataRoots = new Set<string>();
    const errors = new Map<string, string>();
    const current = () => generation === this.generation;
    const degraded = (id: string, reason: string) => errors.set(id, reason);
    const add = async (path: string, id: string, optional = false) => {
      if (!current()) return;
      try {
        path = await realpath(path);
        const info = await stat(path, { bigint: true });
        if (!info.isDirectory()) return;
        const existing = desired.get(path);
        if (existing) {
          existing.owners.add(id);
          return path;
        }
        if (desired.size >= this.capacity) {
          degraded(id, "Watched directory limit reached");
          return;
        }
        desired.set(path, { owners: new Set([id]), identity: `${info.dev}:${info.ino}` });
        return path;
      } catch (error) {
        if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT")
          degraded(id, (error as Error).message);
      }
    };
    const tree = async (root: string, id: string, metadata = false) => {
      const first = await add(root, id, metadata);
      if (!first) return;
      if (!metadata && metadataRoots.has(first)) return;
      const queue = [first];
      for (let index = 0; index < queue.length && current(); index++) {
        try {
          const directory = await opendir(queue[index]!);
          for await (const entry of directory) {
            if (!current()) return;
            const child = join(queue[index]!, entry.name);
            if (
              !entry.isDirectory() ||
              (!metadata && (excluded.has(entry.name) || metadataRoots.has(child)))
            )
              continue;
            const path = await add(child, id);
            if (path) queue.push(path);
            else if (desired.size >= this.capacity) return;
          }
        } catch (error) {
          degraded(id, (error as Error).message);
        }
      }
    };
    for (const [id, active] of this.active)
      for (const repo of active.repos.values()) {
        for (const root of new Set([repo.gitDir, repo.commonDir])) {
          const path = await add(root, id);
          if (path) metadataRoots.add(path);
          for (const name of gitTrees) await tree(join(root, name), id, true);
        }
      }
    for (const [id, active] of this.active)
      for (const path of [...active.recent].reverse()) await add(path, id);
    for (const [id, active] of this.active) await tree(active.root, id);
    if (!current()) return;
    for (const [path, item] of this.entries)
      if (desired.get(path)?.identity !== item.identity) {
        item.watcher.close();
        this.entries.delete(path);
      }
    for (const [path, target] of desired) {
      const existing = this.entries.get(path);
      if (existing) {
        existing.owners = target.owners;
        continue;
      }
      try {
        const watcher = watch(path, { recursive: false }, (event, filename) => {
          const item = this.entries.get(path);
          if (!item) return;
          for (const id of item.owners) this.changed(id);
          if (event === "rename" || !filename) this.schedule();
        });
        watcher.on("error", (error) => {
          const item = this.entries.get(path);
          item?.watcher.close();
          this.entries.delete(path);
          for (const id of item?.owners ?? []) {
            this.errors.set(id, error.message);
            this.report(id);
          }
          this.schedule();
        });
        this.entries.set(path, { ...target, watcher });
      } catch (error) {
        for (const id of target.owners) degraded(id, (error as Error).message);
      }
    }
    this.errors = errors;
    for (const id of this.active.keys()) this.report(id);
  }
  private report(workspaceId: string) {
    this.send({
      type: "watch.status",
      workspaceId,
      status: this.errors.has(workspaceId) ? "degraded" : "normal",
      reason: this.errors.get(workspaceId),
    });
  }
  async close() {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.events);
    this.timer = this.events = undefined;
    for (const item of this.entries.values()) item.watcher.close();
    this.entries.clear();
    this.active.clear();
    this.pending.clear();
    this.errors.clear();
    await this.rebuilding;
  }
}
