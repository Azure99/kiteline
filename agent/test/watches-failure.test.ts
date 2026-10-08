import { expect, test, vi } from "vitest";
import type { WorkerOptions } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import type { WorkspaceEvent } from "@kiteline/shared/protocol";

const fixture = vi.hoisted(() => ({ source: undefined as string | undefined }));
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(path: string | URL, options?: WorkerOptions) {
        super(
          fixture.source
            ? new URL(`data:text/javascript,${encodeURIComponent(fixture.source)}`)
            : path,
          options,
        );
      }
    },
  };
});
import { WorkspaceWatches } from "../src/watches.js";

test.runIf(process.platform === "linux").each([
  ['throw new Error("watch fixture failed")', "watch fixture failed"],
  ["process.exit(0)", "File watcher exited unexpectedly (0)"],
])(
  "worker failure reports degradation and allows explicit resubscription: %s",
  async (source, reason) => {
    const root = await mkdtemp("/var/tmp/kiteline-watch-failure-");
    const events: WorkspaceEvent[] = [];
    const watches = new WorkspaceWatches((event) => events.push(event));
    const workspaces = [{ id: "a", name: "a", path: root }];
    try {
      fixture.source = source;
      watches.set(workspaces);
      await expect
        .poll(() => events, { timeout: 5000 })
        .toEqual([{ type: "watch.status", workspaceId: "a", status: "degraded", reason }]);
      await watches.close();
      fixture.source = undefined;
      events.length = 0;
      watches.set(workspaces);
      await expect
        .poll(
          () => events.some((event) => event.type === "watch.status" && event.status === "normal"),
          { timeout: 5000 },
        )
        .toBe(true);
    } finally {
      fixture.source = undefined;
      await watches.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
