import { useSyncExternalStore } from "react";

const query = matchMedia("(min-width: 960px)");
function subscribe(listener: () => void) {
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
export function useMobile() {
  return useSyncExternalStore(subscribe, isMobile);
}
export function isMobile() {
  return !query.matches;
}
