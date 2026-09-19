import type { Stats } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { limits, type Repo, type Workspace, type WorkspaceEvent } from "@kiteline/shared/protocol";

const excluded = new Set(["node_modules", ".pnpm", ".venv", "dist", "build", "target"]);
const gitTrees = new Set(["refs", "rebase-merge", "rebase-apply", "sequencer"]);
interface Watched {
  watcher: FSWatcher;
  owners: Set<string>;
  ready: boolean;
  error?: string;
}
interface Active {
  root: string;
  repos: Map<string, Repo>;
  metadataRoots: string[];
  tree?: Watched;
}

export class WorkspaceWatches {
  private active = new Map<string, Active>();
  private git = new Map<string, Watched>();
  private closing = new Set<Promise<void>>();
  private pending = new Set<string>();
  private events?: NodeJS.Timeout;
  constructor(private send: (event: WorkspaceEvent) => void) {}

  set(workspaces: Workspace[]) {
    const ids = new Set(workspaces.map((item) => item.id));
    for (const [id, active] of this.active)
      if (!ids.has(id)) {
        if (active.tree) this.stop(active.tree);
        this.active.delete(id);
        this.pending.delete(id);
      }
    for (const item of workspaces)
      if (!this.active.has(item.id))
        this.active.set(item.id, { root: item.path, repos: new Map(), metadataRoots: [] });
    this.reconcile();
  }

  repo(workspaceId: string, repo: Repo) {
    const active = this.active.get(workspaceId);
    if (!active) return;
    const previous = [...active.repos.values()].find((item) => item.rootPath === repo.rootPath);
    if (previous?.id === repo.id) return;
    if (previous) active.repos.delete(previous.id);
    active.repos.set(repo.id, repo);
    this.reconcile();
  }

  reposComplete(workspaceId: string, repoIds: Set<string>) {
    const active = this.active.get(workspaceId);
    if (!active) return;
    for (const id of active.repos.keys()) if (!repoIds.has(id)) active.repos.delete(id);
    this.reconcile();
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

  private reconcile() {
    const desired = new Map<string, Set<string>>();
    for (const [id, active] of this.active)
      for (const repo of active.repos.values())
        for (const root of [repo.gitDir, repo.commonDir]) {
          if (!desired.has(root)) desired.set(root, new Set());
          desired.get(root)!.add(id);
        }
    for (const [root, entry] of this.git)
      if (!desired.has(root)) {
        this.stop(entry);
        this.git.delete(root);
      }
    for (const [root, owners] of desired) {
      const existing = this.git.get(root);
      if (existing) existing.owners = owners;
      else
        this.git.set(
          root,
          this.start(root, (path, info) => ignoreGit(root, path, info), owners),
        );
    }
    for (const [id, active] of this.active) {
      const metadataRoots = [...desired.keys()]
        .filter((root) => {
          const path = relative(active.root, root);
          return (
            within(active.root, root) &&
            !path.split(sep).some((name) => name === ".git" || excluded.has(name))
          );
        })
        .sort();
      if (
        !active.tree ||
        metadataRoots.length !== active.metadataRoots.length ||
        metadataRoots.some((root, index) => root !== active.metadataRoots[index])
      ) {
        if (active.tree) this.stop(active.tree);
        active.metadataRoots = metadataRoots;
        active.tree = this.start(
          active.root,
          (path) => ignoreTree(active.root, metadataRoots, path),
          new Set([id]),
        );
      }
      this.report(id);
    }
  }

  private start(
    root: string,
    ignored: (path: string, info?: Stats) => boolean,
    owners: Set<string>,
  ): Watched {
    const parent = dirname(root);
    const watcher = watch([root, parent], {
      // Watching the parent boundary lets Chokidar reattach a replaced root.
      ignored: (path, info) => path !== parent && (!within(root, path) || ignored(path, info)),
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
    });
    const entry: Watched = { watcher, owners, ready: false };
    watcher.on("all", () => {
      for (const id of entry.owners) this.changed(id);
    });
    watcher.on("ready", () => {
      entry.ready = true;
      for (const id of entry.owners) this.report(id);
    });
    watcher.on("error", (error) => {
      entry.error = error instanceof Error ? error.message : String(error);
      for (const id of entry.owners) this.report(id);
    });
    return entry;
  }

  private report(workspaceId: string) {
    const active = this.active.get(workspaceId);
    if (!active?.tree) return;
    const entries = [
      active.tree,
      ...[...this.git.values()].filter((entry) => entry.owners.has(workspaceId)),
    ];
    const reason = entries.find((entry) => entry.error)?.error;
    if (!reason && entries.some((entry) => !entry.ready)) return;
    this.send({
      type: "watch.status",
      workspaceId,
      status: reason ? "degraded" : "normal",
      reason,
    });
  }

  private stop(entry: Watched) {
    const closing = entry.watcher
      .close()
      .catch((error: unknown) => console.error("Watcher cleanup:", error));
    this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing));
  }

  async close() {
    clearTimeout(this.events);
    this.events = undefined;
    this.pending.clear();
    this.set([]);
    await Promise.all(this.closing);
  }
}

function within(root: string, path: string) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function ignoreTree(root: string, metadataRoots: string[], path: string) {
  const parts = relative(root, path).split(sep);
  const git = parts.indexOf(".git");
  return (
    parts.some((name) => excluded.has(name)) ||
    (git !== -1 && git < parts.length - 1) ||
    metadataRoots.some((metadata) => path !== metadata && within(metadata, path))
  );
}

function ignoreGit(root: string, path: string, info?: Stats) {
  const local = relative(root, path);
  if (!local) return false;
  const parts = local.split(sep);
  return !gitTrees.has(parts[0]!) && (parts.length > 1 || info?.isDirectory() === true);
}
