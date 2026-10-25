import { parentPort } from "node:worker_threads";
import type { Repo, Workspace, WorkspaceEvent } from "@kiteline/shared/protocol";
import { WatchRoots } from "./watch-roots.js";

export type WatchCommand =
  | { type: "set"; revision: number; workspaces: Workspace[] }
  | { type: "repo"; workspaceId: string; repo: Repo }
  | { type: "reposComplete"; workspaceId: string; repoIds: Set<string> }
  | { type: "changed"; workspaceId: string }
  | { type: "close" };
export interface WatchMessage {
  revision: number;
  event: WorkspaceEvent;
}

const port = parentPort!;
let revision = 0;
const watches = new WatchRoots((event) =>
  port.postMessage({ revision, event } satisfies WatchMessage),
);
port.on("message", (message: WatchCommand) => {
  switch (message.type) {
    case "set":
      revision = message.revision;
      watches.set(message.workspaces);
      break;
    case "repo":
      watches.repo(message.workspaceId, message.repo);
      break;
    case "reposComplete":
      watches.reposComplete(message.workspaceId, message.repoIds);
      break;
    case "changed":
      watches.changed(message.workspaceId);
      break;
    case "close":
      void watches.close().then(() => port.close());
      break;
  }
});
