import { AppError, type FileProgress, type Repo } from "@kiteline/shared/protocol";
import type { Repositories } from "./repos.js";

export class GitWriteQueue {
  private tails = new Map<string, Promise<void>>();
  constructor(private repos: Repositories) {}

  async run<T>(
    workspaceId: string,
    repoId: string,
    signal: AbortSignal,
    operation: (repo: Repo) => Promise<T>,
    progress?: (value: FileProgress) => void,
  ): Promise<T> {
    const repo = this.repos.known.get(repoId);
    if (!repo) throw new AppError("not_found", "Repository is unavailable; discover it again");
    const key = repo.commonDir;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    progress?.({ phase: "queued" });
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      await Promise.race([previous, cancelled]);
      signal.throwIfAborted();
      const current = await this.repos.verify(workspaceId, repo, signal);
      progress?.({ phase: "running" });
      return await operation(current);
    } finally {
      signal.removeEventListener("abort", abort);
      release();
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
  }
}
