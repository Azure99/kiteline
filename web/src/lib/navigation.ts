import { useSyncExternalStore } from "react";

export type WorkspaceTool = "terminal" | "files" | "git";
export interface WorkspaceTarget {
  deviceId: string;
  workspaceId: string;
}
export interface WorkspaceQuery {
  session?: string;
  repo?: string;
  file?: string;
  draft?: string;
  folder?: string;
  reveal?: string;
  preview?: "image";
  search?: boolean;
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
export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function useRoute() {
  const location = useSyncExternalStore(subscribe, currentPath);
  const url = new URL(location, window.location.origin);
  return parseRoute(url);
}
export function parseRoute(url: URL) {
  const params = url.searchParams;
  const query: WorkspaceQuery = {
    session: params.get("session") ?? undefined,
    repo: params.get("repo") ?? undefined,
    file: params.get("file") ?? undefined,
    draft: params.get("draft") ?? undefined,
    folder: params.get("folder") ?? undefined,
    reveal: params.get("reveal") ?? undefined,
    preview: params.get("preview") === "image" ? "image" : undefined,
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
    valid: !!match || url.pathname === "/",
    deviceId,
    workspaceId,
    tool: match?.[3] as WorkspaceTool | undefined,
    query,
  };
}
export function devicePath(deviceId: string) {
  return `/devices/${encodeURIComponent(deviceId)}`;
}
export function workspacePath(
  deviceId: string,
  workspaceId: string,
  tool: WorkspaceTool = "terminal",
  query: WorkspaceQuery = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === false || (key === "folder" && value === ".")) continue;
    params.set(key, value === true ? "1" : value);
  }
  return `${devicePath(deviceId)}/workspaces/${encodeURIComponent(workspaceId)}/${tool}${params.size ? `?${params}` : ""}`;
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
  replace = false,
) {
  const path = workspaceDestination(target, tool, changes);
  if (path !== currentPath()) navigate(path, replace);
}
export function updateWorkspaceQuery(
  target: WorkspaceTarget,
  changes: WorkspaceQuery,
  replace = false,
) {
  const current = currentRoute();
  if (current.tool && isWorkspaceRoute(current, target))
    navigateWorkspace(target, current.tool, changes, replace);
}
