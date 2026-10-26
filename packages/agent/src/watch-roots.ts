import {
  lstatSync,
  watch as nativeWatch,
  type FSWatcher as NativeWatcher,
  type Stats,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { watch } from "chokidar";
import {
  asError,
  limits,
  type Repo,
  type Workspace,
  type WorkspaceEvent,
} from "@kiteline/shared/protocol";

const excluded = new Set(["node_modules", ".pnpm", ".venv", "dist", "build", "target"]);
const gitTrees = new Set(["refs", "rebase-merge", "rebase-apply", "sequencer"]);
interface Watched {
  watcher: { close(): Promise<void> };
  owners: Set<string>;
  ready: boolean;
  error?: string;
  observedRoot?: string;
}
interface Active {
  root: string;
  repos: Map<string, Repo>;
  metadataRoots: string[];
  tree?: Watched;
}

export class WatchRoots {
  private active = new Map<string, Active>();
  private git = new Map<string, Watched>();
  private closing = new Set<Promise<void>>();
  private pending = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private rebuildPending = false;
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

  notifyWritten(workspaceId: string) {
    if (!this.active.has(workspaceId)) return;
    this.pending.delete(workspaceId);
    this.emit(workspaceId);
  }

  private scheduleChange(workspaceId: string) {
    if (!this.active.has(workspaceId)) return;
    this.pending.add(workspaceId);
    this.scheduleFlush();
  }

  private scheduleRebuild() {
    this.rebuildPending = true;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    this.flushTimer ??= setTimeout(() => this.flush(), limits.watchDebounce);
  }

  private flush() {
    this.flushTimer = undefined;
    if (this.rebuildPending) {
      this.rebuildPending = false;
      this.reconcile();
    }
    for (const id of this.pending) this.emit(id);
    this.pending.clear();
  }

  private observed(path: string, owners: Set<string>) {
    for (const id of owners) this.scheduleChange(id);
    for (const [id, active] of this.active)
      if (isAncestorOrSelf(path, active.root)) {
        this.scheduleChange(id);
        if (process.platform === "linux" && path !== active.root && active.tree) {
          // A missing ancestor can retire this registration before the path returns.
          this.stop(active.tree);
          active.tree = undefined;
          this.scheduleRebuild();
        }
      }
    for (const [root, entry] of this.git)
      if (isAncestorOrSelf(path, root)) {
        for (const id of entry.owners) this.scheduleChange(id);
        if (process.platform === "linux" && path !== root) {
          this.stop(entry);
          this.git.delete(root);
          this.scheduleRebuild();
        }
      }
  }

  private emit(workspaceId: string) {
    this.send({ type: "workspace.changed", workspaceId });
  }

  private reconcile() {
    const desired = new Map<string, Set<string>>();
    for (const [id, active] of this.active)
      for (const repo of active.repos.values())
        for (const root of [repo.gitDir, repo.commonDir]) {
          if (!desired.has(root)) desired.set(root, new Set());
          desired.get(root)!.add(id);
        }
    // Windows descendant handles prevent ancestor renames. Chokidar 6 shares
    // a recursive handle when overlapping subscriptions use the same boundary.
    const windowsBoundaries =
      process.platform === "win32"
        ? [
            ...[...this.active.values()].map((active) => dirname(active.root)),
            ...[...desired.keys()].map((root) => dirname(root)),
          ]
        : [];
    const windowsObservationRoot = (root: string) => {
      if (process.platform !== "win32") return undefined;
      let outermost = dirname(root);
      for (const boundary of windowsBoundaries)
        if (isAncestorOrSelf(boundary, outermost)) outermost = boundary;
      return outermost;
    };
    for (const [root, entry] of this.git)
      if (!desired.has(root)) {
        this.stop(entry);
        this.git.delete(root);
      }
    for (const [root, owners] of desired) {
      const existing = this.git.get(root);
      const observedRoot = windowsObservationRoot(root);
      if (existing && existing.observedRoot === observedRoot) {
        existing.owners = owners;
      } else {
        if (existing) this.stop(existing);
        this.git.set(
          root,
          this.start(root, (path, info) => ignoreGit(root, path, info), owners, { observedRoot }),
        );
      }
    }
    for (const [id, active] of this.active) {
      const observedRoot = windowsObservationRoot(active.root);
      const metadataRoots = [...desired.keys()]
        .filter((root) => {
          const path = relative(active.root, root);
          return (
            isAncestorOrSelf(active.root, root) &&
            !path.split(sep).some((name) => name === ".git" || excluded.has(name))
          );
        })
        .sort();
      if (
        !active.tree ||
        active.tree.observedRoot !== observedRoot ||
        metadataRoots.length !== active.metadataRoots.length ||
        metadataRoots.some((root, index) => root !== active.metadataRoots[index])
      ) {
        if (active.tree) this.stop(active.tree);
        active.metadataRoots = metadataRoots;
        const ignored = (path: string) => ignoreTree(active.root, metadataRoots, path);
        active.tree =
          process.platform === "darwin"
            ? this.startNative(active.root, ignored, new Set([id]))
            : this.start(active.root, ignored, new Set([id]), {
                directoriesOnly: process.platform === "linux",
                observedRoot,
              });
      }
      this.report(id);
    }
  }

  private start(
    root: string,
    ignored: (path: string, info?: Stats) => boolean,
    owners: Set<string>,
    { directoriesOnly = false, observedRoot }: { directoriesOnly?: boolean; observedRoot?: string },
  ): Watched {
    const parent = dirname(root);
    const windows = process.platform === "win32";
    const watcher = watch(observedRoot ?? [root, parent], {
      // Watching the parent boundary lets Chokidar reattach a replaced root.
      ignored: (path, info) => {
        // Chokidar supplies forward slashes here, including on Windows.
        path = resolve(path);
        // A shared boundary must still reach this logical root through its ancestors.
        if (windows && isAncestorOrSelf(path, root)) return false;
        return (
          path !== parent &&
          (!isAncestorOrSelf(root, path) ||
            ignored(path, info) ||
            (directoriesOnly && info !== undefined && !info.isDirectory()))
        );
      },
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
    });
    const entry: Watched = { watcher, owners, ready: false, observedRoot };
    watcher.on("raw", (_event, path, details) => {
      const { watchedPath } = details as { watchedPath?: string };
      if (windows) {
        if (watchedPath) {
          const absolute = path ? resolve(watchedPath, path) : resolve(watchedPath);
          if (isAncestorOrSelf(absolute, root)) this.observed(absolute, entry.owners);
        }
        return;
      }
      // Root replacement can preserve every child name and emit no Chokidar all event.
      if (watchedPath === parent && (!path || resolve(parent, path) === root)) {
        this.observed(root, entry.owners);
        return;
      }
      if (!directoriesOnly || !watchedPath) return;
      const absolute = path ? resolve(watchedPath, path) : watchedPath;
      if (isAncestorOrSelf(root, absolute) && !ignored(absolute))
        this.observed(absolute, entry.owners);
    });
    watcher.on("all", (_event, path) => this.observed(path, entry.owners));
    watcher.on("ready", () => {
      entry.ready = true;
      for (const id of entry.owners) this.report(id);
    });
    watcher.on("error", (error) => {
      if (process.platform === "linux" && entry.error) return;
      entry.error = asError(error).message;
      for (const id of entry.owners) this.report(id);
    });
    return entry;
  }

  private startNative(
    root: string,
    ignored: (path: string) => boolean,
    owners: Set<string>,
  ): Watched {
    const parent = dirname(root);
    let tree: NativeWatcher | undefined;
    let boundary: NativeWatcher | undefined;
    let closed = false;
    const entry: Watched = {
      owners,
      ready: false,
      watcher: {
        async close() {
          closed = true;
          tree?.close();
          boundary?.close();
        },
      },
    };
    const changed = (path = root) => {
      if (!closed) this.observed(path, entry.owners);
    };
    const failed = (error: unknown) => {
      if (closed) return;
      entry.error = asError(error).message;
      for (const id of entry.owners) this.report(id);
    };
    const attach = () => {
      try {
        // An existing FSEvents watch follows the registered path across root replacements.
        if (!lstatSync(root).isDirectory()) return;
        tree = nativeWatch(root, { recursive: true }, (_event, filename) => {
          const path = filename ? resolve(root, String(filename)) : root;
          if (isAncestorOrSelf(root, path) && !ignored(path)) changed(path);
        });
        tree.on("error", failed);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") failed(error);
      }
    };
    try {
      boundary = nativeWatch(parent, (event, filename) => {
        if (closed || (filename && resolve(parent, String(filename)) !== root)) return;
        if (!tree && (event === "rename" || !filename)) attach();
        changed();
      });
      boundary.on("error", failed);
      attach();
    } catch (error) {
      failed(error);
    }
    // Native fs.watch is registered synchronously and has no Chokidar initial scan.
    queueMicrotask(() => {
      if (closed) return;
      entry.ready = true;
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
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.rebuildPending = false;
    this.pending.clear();
    this.set([]);
    await Promise.all(this.closing);
  }
}

function isAncestorOrSelf(ancestor: string, descendant: string) {
  return (
    descendant === ancestor ||
    descendant.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep)
  );
}

function ignoreTree(root: string, metadataRoots: string[], path: string) {
  const parts = relative(root, path).split(sep);
  const git = parts.indexOf(".git");
  return (
    parts.some((name) => excluded.has(name)) ||
    (git !== -1 && git < parts.length - 1) ||
    metadataRoots.some((metadata) => path !== metadata && isAncestorOrSelf(metadata, path))
  );
}

function ignoreGit(root: string, path: string, info?: Stats) {
  const local = relative(root, path);
  if (!local) return false;
  const parts = local.split(sep);
  return !gitTrees.has(parts[0]!) && (parts.length > 1 || info?.isDirectory() === true);
}
