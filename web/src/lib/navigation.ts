import { useSyncExternalStore } from "react";

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
  const location = useSyncExternalStore(
    subscribe,
    () => window.location.pathname + window.location.search,
  );
  const url = new URL(location, window.location.origin);
  const match = /^\/devices(?:\/([^/]+)(?:\/workspaces\/([^/]+)\/(terminal|files|git))?)?\/?$/.exec(
    url.pathname,
  );
  return {
    valid: !!match || url.pathname === "/",
    deviceId: match?.[1] && decodeURIComponent(match[1]),
    workspaceId: match?.[2] && decodeURIComponent(match[2]),
    tool: match?.[3] as "terminal" | "files" | "git" | undefined,
    query: url.searchParams,
  };
}
export function devicePath(deviceId: string) {
  return `/devices/${encodeURIComponent(deviceId)}`;
}
export function workspacePath(deviceId: string, workspaceId: string, tool = "terminal") {
  return `${devicePath(deviceId)}/workspaces/${encodeURIComponent(workspaceId)}/${tool}`;
}
