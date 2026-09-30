import { useEffect, useRef, useState } from "react";
import type { Device } from "@kiteline/shared/protocol";
import { type WorkspaceTool, type parseRoute, workspacePath } from "../lib/navigation";

export interface RecentWorkspace {
  deviceId: string;
  workspaceId: string;
  lastTool: WorkspaceTool;
}

const storageKey = "kiteline.recentWorkspaces";
const recentLimit = 8;

export function readRecents(value: unknown): RecentWorkspace[] {
  if (!Array.isArray(value)) return [];
  const entries: RecentWorkspace[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.deviceId !== "string" ||
      typeof entry.workspaceId !== "string" ||
      !["terminal", "files", "git"].includes(entry.lastTool) ||
      entries.some(
        (saved) => saved.deviceId === entry.deviceId && saved.workspaceId === entry.workspaceId,
      )
    )
      continue;
    entries.push({
      deviceId: entry.deviceId,
      workspaceId: entry.workspaceId,
      lastTool: entry.lastTool,
    });
    if (entries.length === recentLimit) break;
  }
  return entries;
}

export function visitWorkspace(entries: RecentWorkspace[], entry: RecentWorkspace) {
  return [
    entry,
    ...entries.filter(
      (saved) => saved.deviceId !== entry.deviceId || saved.workspaceId !== entry.workspaceId,
    ),
  ].slice(0, recentLimit);
}

export function pruneRecents(entries: RecentWorkspace[], devices: Device[]) {
  const next = entries.filter((entry) => {
    const device = devices.find((item) => item.id === entry.deviceId);
    if (!device) return false;
    return (
      device.status !== "online" ||
      !device.snapshot ||
      device.snapshot.workspaces.some((item) => item.id === entry.workspaceId)
    );
  });
  return next.length === entries.length ? entries : next;
}

export function useRecentWorkspaces(
  route: ReturnType<typeof parseRoute>,
  devices: Device[],
  loaded: boolean,
  active: boolean,
) {
  const [recents, setRecents] = useState(() => {
    try {
      return readRecents(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
    } catch {
      return [];
    }
  });
  const visit = useRef<{ key?: string; recorded: boolean }>({ recorded: false });
  const { deviceId, workspaceId, tool } = route;
  const key =
    active && route.valid && deviceId && workspaceId && tool
      ? workspacePath(deviceId, workspaceId, tool)
      : undefined;
  useEffect(() => {
    if (visit.current.key !== key) visit.current = { key, recorded: false };
    if (!active || !loaded) return;
    const device = devices.find((item) => item.id === deviceId);
    const workspace = device?.snapshot?.workspaces.find((item) => item.id === workspaceId);
    let entry: RecentWorkspace | undefined;
    if (key && !visit.current.recorded && device && workspace && tool) {
      entry = {
        deviceId: device.id,
        workspaceId: workspace.id,
        lastTool: tool,
      };
      visit.current.recorded = true;
    }
    setRecents((old) => {
      const next = pruneRecents(old, devices);
      return entry ? visitWorkspace(next, entry) : next;
    });
  }, [active, loaded, key, devices, deviceId, workspaceId, tool]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(recents));
    } catch {
      // Navigation remains available when browser storage is unavailable.
    }
  }, [recents]);
  return recents;
}
