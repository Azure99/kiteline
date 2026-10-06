import type { BrowserEvent } from "@kiteline/shared/protocol";
import type { FileTarget } from "../files/content";
import type { FileOperationResult } from "../files/operation-dialog";

declare global {
  interface WindowEventMap {
    "kiteline:event": CustomEvent<BrowserEvent>;
    "kiteline:file-written": CustomEvent<FileTarget>;
    "kiteline:download": CustomEvent<FileTarget>;
    "kiteline:files-operated": CustomEvent<FileOperationResult>;
    "kiteline:connected": Event;
    "kiteline:unauthenticated": Event;
    "kiteline:viewport": Event;
  }
}

export function emit<K extends keyof WindowEventMap>(
  name: K,
  detail: WindowEventMap[K] extends CustomEvent<infer D> ? D : never,
) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
