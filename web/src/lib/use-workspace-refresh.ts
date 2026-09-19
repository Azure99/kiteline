import { useEffect, useRef, useState } from "react";
import { limits } from "@kiteline/shared/protocol";

interface WorkspaceEvent {
  type: string;
  deviceId: string;
  workspaceId: string;
  scopes?: string[];
  status?: "normal" | "degraded";
  reason?: string;
}
export function useWorkspaceRefresh(
  deviceId: string,
  workspaceId: string,
  active: boolean,
  scope: "files" | "git" | "repos",
  refresh: (signal: AbortSignal) => unknown,
) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let running = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      timer = undefined;
      if (controller.signal.aborted || document.hidden) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        await callback.current(controller.signal);
      } finally {
        running = false;
        if (pending && !controller.signal.aborted) {
          pending = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      timer ??= setTimeout(() => void run(), limits.watchDebounce);
    };
    const event = (event: Event) => {
      const value = (event as CustomEvent<WorkspaceEvent>).detail;
      if (
        value.type === "workspace.changed" &&
        value.deviceId === deviceId &&
        value.workspaceId === workspaceId &&
        value.scopes?.includes(scope)
      )
        schedule();
    };
    const visible = () => {
      if (!document.hidden) schedule();
    };
    window.addEventListener("kiteline:event", event);
    window.addEventListener("kiteline:connected", schedule);
    document.addEventListener("visibilitychange", visible);
    const interval = setInterval(schedule, limits.visibleRefreshInterval);
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("kiteline:event", event);
      window.removeEventListener("kiteline:connected", schedule);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [deviceId, workspaceId, active, scope]);
}

export function useWatchStatus(deviceId: string, workspaceId: string) {
  const [reason, setReason] = useState<string>();
  useEffect(() => {
    setReason(undefined);
    const event = (event: Event) => {
      const value = (event as CustomEvent<WorkspaceEvent>).detail;
      if (
        value.type === "watch.status" &&
        value.deviceId === deviceId &&
        value.workspaceId === workspaceId
      )
        setReason(value.status === "degraded" ? (value.reason ?? "") : undefined);
    };
    window.addEventListener("kiteline:event", event);
    return () => window.removeEventListener("kiteline:event", event);
  }, [deviceId, workspaceId]);
  return reason;
}
