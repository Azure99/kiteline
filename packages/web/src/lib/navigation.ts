import { useMemo, useSyncExternalStore } from "react";

import {
  workspacePath,
  type WorkspaceTool,
  type WorkspaceQuery,
} from "@kiteline/shared/protocol/navigation";
export * from "@kiteline/shared/protocol/navigation";

export interface WorkspaceTarget {
  deviceId: string;
  workspaceId: string;
}
export interface NavigationOptions {
  // Replace keeps the work page identity in history.state; push starts without it.
  replace?: boolean;
  // "open" still notifies on an unchanged URL, so a repeated open reaches its owner.
  intent?: "open" | "view";
}

type NavigationIntent = NonNullable<NavigationOptions["intent"]> | "lookup";
type RouteChangeEvent = PopStateEvent & { navigationIntent?: NavigationIntent };

export function navigationIntent(event: PopStateEvent) {
  return (event as RouteChangeEvent).navigationIntent;
}
export function notifyNavigation(intent: NavigationIntent) {
  const event: RouteChangeEvent = new PopStateEvent("popstate");
  event.navigationIntent = intent;
  window.dispatchEvent(event);
}
export interface TasksRoute {
  filter?: string;
  deviceId?: string;
  taskId?: string;
  runId?: string;
}

export function currentPath() {
  return window.location.pathname + window.location.search;
}
export function currentRoute() {
  return parseRoute(new URL(window.location.href));
}
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
export function navigate(
  path: string,
  { replace = false, intent = "open" }: NavigationOptions = {},
) {
  if (path !== currentPath()) {
    if (replace) history.replaceState(history.state, "", path);
    else history.pushState(null, "", path);
  } else if (intent === "view") return;
  notifyNavigation(intent);
}
export function useRoute() {
  const path = useSyncExternalStore(subscribe, currentPath);
  return useMemo(() => parseRoute(new URL(window.location.origin + path)), [path]);
}
export function parseRoute(url: URL) {
  const params = url.searchParams;
  const line = Number(params.get("line"));
  const tasks: TasksRoute | undefined =
    url.pathname === "/tasks"
      ? {
          filter: params.get("device") ?? undefined,
          deviceId: params.get("target") ?? undefined,
          taskId: params.get("task") ?? undefined,
          runId: params.get("run") ?? undefined,
        }
      : undefined;
  const query: WorkspaceQuery = {
    session: params.get("session") ?? undefined,
    repo: params.get("repo") ?? undefined,
    file: params.get("file") ?? undefined,
    line: Number.isSafeInteger(line) && line > 0 ? line : undefined,
    draft: params.get("draft") ?? undefined,
    folder: params.get("folder") ?? undefined,
    reveal: params.get("reveal") ?? undefined,
    search: params.get("search") === "1" ? true : undefined,
  };
  const match = /^\/devices(?:\/([^/]+)(?:\/workspaces\/([^/]+)\/(terminal|files|git))?)?\/?$/.exec(
    url.pathname,
  );
  let deviceId: string | undefined, workspaceId: string | undefined;
  try {
    deviceId = match?.[1] && decodeURIComponent(match[1]);
    workspaceId = match?.[2] && decodeURIComponent(match[2]);
  } catch {
    return { valid: false, query };
  }
  return {
    valid: !!match || url.pathname === "/" || !!tasks,
    deviceId: tasks?.deviceId ?? tasks?.filter ?? deviceId,
    workspaceId,
    tool: match?.[3] as WorkspaceTool | undefined,
    query,
    tasks,
  };
}
export function tasksPath(route: TasksRoute = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    device: route.filter,
    target: route.deviceId,
    task: route.taskId,
    run: route.runId,
  }))
    if (value !== undefined) params.set(key, value);
  const search = params.toString();
  return `/tasks${search ? `?${search}` : ""}`;
}
export function isWorkspaceRoute(route: ReturnType<typeof parseRoute>, target: WorkspaceTarget) {
  return route.deviceId === target.deviceId && route.workspaceId === target.workspaceId;
}
export function workspaceDestination(
  target: WorkspaceTarget,
  tool: WorkspaceTool,
  changes: WorkspaceQuery = {},
) {
  const current = currentRoute();
  const query = { ...(isWorkspaceRoute(current, target) ? current.query : {}), ...changes };
  return workspacePath(target.deviceId, target.workspaceId, tool, query);
}
export function navigateWorkspace(
  target: WorkspaceTarget,
  tool: WorkspaceTool,
  changes: WorkspaceQuery = {},
  options: NavigationOptions = {},
) {
  navigate(workspaceDestination(target, tool, changes), options);
}
export function updateWorkspaceQuery(
  target: WorkspaceTarget,
  changes: WorkspaceQuery,
  options: NavigationOptions = {},
) {
  const current = currentRoute();
  if (current.tool && isWorkspaceRoute(current, target))
    navigateWorkspace(target, current.tool, changes, { intent: "view", ...options });
}
