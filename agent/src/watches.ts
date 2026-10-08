import { Worker } from "node:worker_threads";
import { asError, type Repo, type Workspace, type WorkspaceEvent } from "@kiteline/shared/protocol";
import { WatchRoots } from "./watch-roots.js";
import type { WatchCommand, WatchMessage } from "./watch-worker.js";

interface Instance {
  worker: Worker;
  done: Promise<void>;
}

export class WorkspaceWatches {
  private local?: WatchRoots;
  private instance?: Instance;
  private closing = new Set<Promise<void>>();
  private active = new Set<string>();
  private revision = 0;

  constructor(private send: (event: WorkspaceEvent) => void) {
    if (process.platform !== "linux") this.local = new WatchRoots(send);
  }

  set(workspaces: Workspace[]) {
    if (this.local) return this.local.set(workspaces);
    this.active = new Set(workspaces.map((workspace) => workspace.id));
    this.revision++;
    if (!workspaces.length) {
      void this.close();
      return;
    }
    try {
      this.instance ??= this.start();
      this.post({ type: "set", revision: this.revision, workspaces });
    } catch (error) {
      this.failed(asError(error).message);
    }
  }

  repo(workspaceId: string, repo: Repo) {
    if (this.local) this.local.repo(workspaceId, repo);
    else this.post({ type: "repo", workspaceId, repo });
  }

  reposComplete(workspaceId: string, repoIds: Set<string>) {
    if (this.local) this.local.reposComplete(workspaceId, repoIds);
    else this.post({ type: "reposComplete", workspaceId, repoIds });
  }

  changed(workspaceId: string, immediate = false) {
    if (this.local) this.local.changed(workspaceId, immediate);
    else if (immediate && this.active.has(workspaceId))
      this.send({ type: "workspace.changed", workspaceId, scopes: ["files", "git", "repos"] });
    else this.post({ type: "changed", workspaceId });
  }

  private post(message: WatchCommand) {
    this.instance?.worker.postMessage(message);
  }

  private start(): Instance {
    // Tests use the source facade and the same compiled worker shipped in the package.
    const worker = new Worker(new URL("../dist/watch-worker.js", import.meta.url));
    let finish!: () => void;
    const instance = { worker, done: new Promise<void>((resolve) => (finish = resolve)) };
    let error: Error | undefined;
    worker.on("message", ({ revision, event }: WatchMessage) => {
      if (this.instance !== instance || !this.active.has(event.workspaceId)) return;
      if (event.type === "watch.status" && revision !== this.revision) return;
      this.send(event);
    });
    worker.on("error", (reason) => {
      error = reason;
    });
    worker.once("exit", (code) => {
      if (this.instance === instance) {
        this.instance = undefined;
        this.failed(error?.message ?? `File watcher exited unexpectedly (${code})`);
      } else if (error) console.error("File watcher cleanup:", error);
      finish();
    });
    return instance;
  }

  private failed(reason: string) {
    console.error("File watcher:", reason);
    for (const workspaceId of this.active)
      this.send({ type: "watch.status", workspaceId, status: "degraded", reason });
  }

  async close() {
    if (this.local) return this.local.close();
    this.active.clear();
    const instance = this.instance;
    if (instance) {
      this.instance = undefined;
      instance.worker.postMessage({ type: "close" } satisfies WatchCommand);
      this.closing.add(instance.done);
      void instance.done.then(() => this.closing.delete(instance.done));
    }
    await Promise.all(this.closing);
  }
}
