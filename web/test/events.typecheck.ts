import type { AgentEvent, BrowserEvent } from "@kiteline/shared/protocol";
import type {} from "../src/lib/events";

export function checkEvents(event: BrowserEvent) {
  // @ts-expect-error not every browser event has a workspace
  void event.workspaceId;
  if (event.type === "workspace.changed") event.scopes.includes("git");
  if (event.type === "channel.failed") event.error.code.toUpperCase();
  // @ts-expect-error session changes need their workspace at the producer
  const session = { type: "sessions.changed" } satisfies AgentEvent;
  // @ts-expect-error request progress uses queued/running, not a completion state
  const progress = { type: "request.progress", id: "r", phase: "done" } satisfies AgentEvent;
  // @ts-expect-error forwarded progress needs a device
  const forwarded = { type: "request.progress", id: "r", phase: "running" } satisfies BrowserEvent;
  void [session, progress, forwarded];
}

export function checkWindowEvents() {
  window.addEventListener("kiteline:file-written", (event) => {
    event.detail.path.toUpperCase();
    // @ts-expect-error file events carry a file target, not a browser event
    void event.detail.type;
  });
  window.addEventListener("kiteline:event", (event) => checkEvents(event.detail));
  // @ts-expect-error file-written producers must include the workspace and path
  const target = { deviceId: "d" } satisfies WindowEventMap["kiteline:file-written"]["detail"];
  void target;
}
