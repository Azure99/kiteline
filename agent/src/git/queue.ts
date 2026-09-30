import { stat } from "node:fs/promises";
import type { FileProgress, Repo } from "@kiteline/shared/protocol";
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
    const repo = await this.repos.resolve(workspaceId, repoId, signal);
    const info = await stat(repo.commonDir, { bigint: true });
    const key = `${info.dev}:${info.ino}`;
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
