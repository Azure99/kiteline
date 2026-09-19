import { useSyncExternalStore } from "react";
import { appVersion } from "@kiteline/shared/protocol";

let serverVersion: string | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function observeServerVersion(version: string | null) {
  if (!version || version === serverVersion) return;
  serverVersion = version;
  for (const listener of listeners) listener();
}
export function webCompatible() {
  return serverVersion === undefined || serverVersion === appVersion;
}
export function useServerVersion() {
  return useSyncExternalStore(subscribe, () => serverVersion);
}
export function versionedPath(path: string) {
  const url = new URL(path, "https://kiteline.invalid");
  url.searchParams.set("appVersion", appVersion);
  return url.pathname + url.search;
}
