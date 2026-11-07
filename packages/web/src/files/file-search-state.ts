import type { SearchResult } from "@kiteline/shared/protocol";
import type { CodeNavigationRequest, NavigationSearchEntry } from "./code-navigation";
import type { NavigationTracker } from "./navigation-tracker";

export type NavigationSession = CodeNavigationRequest & { id: string; tracker: NavigationTracker };
export type SearchResponse = SearchResult & { query: string; wholeWord: boolean };
export type FileSearchView = "manual" | "navigation";
export type OpenSearchEntry = (
  request: { entry: NavigationSearchEntry; focusContent?: boolean } & (
    | { kind: "search"; query: string | undefined; wholeWord: boolean }
    | { kind: "lookup"; lookup: { sessionId: string; entryKey: string } }
  ),
) => void;

export interface FileSearchState {
  mode: "name" | "content";
  query: string;
  includeIgnored: boolean;
  wholeWord: boolean;
  result?: SearchResponse;
}

export interface FileNavigationState {
  session: NavigationSession;
  result?: SearchResponse;
  selection?: { entry: NavigationSearchEntry; requestId: string };
}

export interface FileSearchMemory {
  fileSearch?: FileSearchState;
  fileNavigation?: FileNavigationState;
  fileSearchView?: FileSearchView;
}

export function endFileNavigation(memory: FileSearchMemory) {
  memory.fileNavigation?.session.tracker.dispose();
  memory.fileNavigation = undefined;
  memory.fileSearchView = "manual";
}
