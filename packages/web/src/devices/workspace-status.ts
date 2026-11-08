import { useEffect, useRef, useState } from "react";
import type { Device, ProgramStatusSummary, Session } from "@kiteline/shared/protocol";
import { rpc } from "../lib/api";
import type { ReceivedReport } from "../terminal/reports";

export interface TerminalStatus {
  deviceId: string;
  workspaceId: string;
  sessionId: string;
  name: string;
  summary?: ProgramStatusSummary;
  current: boolean;
  report?: ReceivedReport;
}

export interface WorkspaceStatus {
  terminals: TerminalStatus[];
  stale: boolean;
  offline: boolean;
  error?: unknown;
}

interface DeviceSessions {
  sessions: Session[];
  current: boolean;
  error?: unknown;
}

interface DeviceSessionReader {
  controller: AbortController;
  read(): Promise<void>;
}

/** Reads session summaries without expanding workspace file or Git watches. */
export function useDeviceSessions(devices: Device[], connected: boolean) {
  const onlineIds = new Set(
    devices.filter((device) => device.status === "online").map((device) => device.id),
  );
  const online = [...onlineIds].sort().join(",");
  const readers = useRef(new Map<string, DeviceSessionReader>());
  const [lists, setLists] = useState<Record<string, DeviceSessions>>({});

  useEffect(() => {
    const active = readers.current;
    return () => {
      for (const reader of active.values()) reader.controller.abort();
      active.clear();
    };
  }, []);

  useEffect(() => {
    const active = readers.current;
    const ids = new Set(connected && online ? online.split(",") : []);
    const stopped: string[] = [];
    for (const [id, reader] of active) {
      if (ids.has(id)) continue;
      reader.controller.abort();
      active.delete(id);
      stopped.push(id);
    }
    if (stopped.length) {
      setLists((previous) => {
        const next = { ...previous };
        for (const id of stopped) {
          const list = next[id];
          if (list) next[id] = { ...list, current: false };
        }
        return next;
      });
    }
    for (const deviceId of ids) {
      if (active.has(deviceId)) continue;
      const controller = new AbortController();
      let reading = false;
      let again = false;
      async function read() {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          const { sessions } = await rpc(deviceId, "sessions.list", {}, controller.signal);
          if (!controller.signal.aborted)
            setLists((previous) => ({ ...previous, [deviceId]: { sessions, current: true } }));
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error("Could not read device terminal statuses", deviceId, error);
            setLists((previous) => ({
              ...previous,
              [deviceId]: { sessions: previous[deviceId]?.sessions ?? [], current: false, error },
            }));
          }
        } finally {
          reading = false;
          if (again && !controller.signal.aborted) {
            again = false;
            void read();
          }
        }
      }
      active.set(deviceId, { controller, read });
      void read();
    }
    const changed = (event: WindowEventMap["kiteline:event"]) => {
      const message = event.detail;
      if (message.type === "sessions.changed") void active.get(message.deviceId)?.read();
    };
    window.addEventListener("kiteline:event", changed);
    return () => window.removeEventListener("kiteline:event", changed);
  }, [connected, online]);

  return Object.fromEntries(
    Object.entries(lists).map(([id, list]): [string, DeviceSessions] => [
      id,
      {
        ...list,
        current: connected && onlineIds.has(id) && list.current,
      },
    ]),
  );
}

/** Badge buckets in display order; terminals in a list follow the same order. */
export const badgeBuckets = ["error", "blocked", "done", "working"] as const;
export type BadgeBucket = (typeof badgeBuckets)[number];

type State = ProgramStatusSummary["states"][number];

/** A wait or an error leads until the program clears it. */
export const isOpen = (state: State) => state === "error" || state === "blocked";

/**
 * The state a terminal shows, from states listed newest first: the newest open wait or error,
 * otherwise the newest non-idle state. The list's lead record follows the same rule.
 */
export function leadState(states: readonly State[]) {
  const active = states.filter((state) => state !== "idle");
  return active.find(isOpen) ?? active[0];
}

/**
 * Each terminal counts once, in the state its list row shows. An unread notification selects
 * "done" only when the program reports no non-idle state.
 */
export function terminalBucket(terminal: TerminalStatus): BadgeBucket | undefined {
  return leadState(terminal.summary?.states ?? []) ?? (terminal.report && "done");
}

export function badgeCounts(status: WorkspaceStatus) {
  const counts = Object.fromEntries(badgeBuckets.map((bucket) => [bucket, 0])) as Record<
    BadgeBucket,
    number
  >;
  for (const terminal of status.terminals) {
    const bucket = terminalBucket(terminal);
    if (bucket) counts[bucket]++;
  }
  return counts;
}

export function reminderCount(statuses: ReadonlyMap<string, WorkspaceStatus>) {
  let count = 0;
  for (const status of statuses.values()) {
    for (const terminal of status.terminals) {
      if (
        terminal.report ||
        terminal.summary?.states.some((state) => isOpen(state) || state === "done")
      )
        count++;
    }
  }
  return count;
}

export function workspaceStatuses(
  devices: Device[],
  lists: Record<string, DeviceSessions>,
  reports: ReceivedReport[],
) {
  const result = new Map<string, WorkspaceStatus>();
  for (const device of devices) {
    const list = lists[device.id];
    const offline = device.status !== "online";
    const stale = offline || !list?.current;
    for (const workspace of device.snapshot?.workspaces ?? []) {
      const terminals: TerminalStatus[] = [];
      const workspaceReports = reports.filter(
        (report) => report.deviceId === device.id && report.workspaceId === workspace.id,
      );
      for (const session of list?.sessions ?? []) {
        if (session.workspaceId !== workspace.id) continue;
        const report = workspaceReports.find((item) => item.sessionId === session.id);
        if (!session.programStatus?.states.length && !report) continue;
        terminals.push({
          deviceId: device.id,
          workspaceId: workspace.id,
          sessionId: session.id,
          name: session.name,
          summary: session.programStatus,
          current: !stale && session.webStatus === "available",
          report,
        });
      }
      for (const report of workspaceReports)
        if (!terminals.some((terminal) => terminal.sessionId === report.sessionId))
          terminals.push({ ...report, current: false, report });
      if (!terminals.length) continue;
      const rank = (terminal: TerminalStatus) => {
        const bucket = terminalBucket(terminal);
        return bucket ? badgeBuckets.indexOf(bucket) : badgeBuckets.length;
      };
      terminals.sort((a, b) => rank(a) - rank(b));
      result.set(`${device.id}/${workspace.id}`, {
        terminals,
        stale:
          stale ||
          terminals.some((terminal) => terminal.summary?.states.length && !terminal.current),
        offline,
        error: list?.error,
      });
    }
  }
  return result;
}
