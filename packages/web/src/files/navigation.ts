import { useEffect, useState } from "react";
import { newId } from "../lib/id";
import type { WorkspaceRecord } from "../workspace/memory";
import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  navigationIntent,
  notifyNavigation,
  workspaceDestination,
  updateWorkspaceQuery,
  type NavigationOptions,
  type WorkspaceTarget,
} from "../lib/navigation";
import type { Draft } from "./drafts";
import { parentPath } from "./paths";
import type { FileTarget } from "./content";

export function fileNavigationView(memory: WorkspaceRecord): NavigationOptions {
  return { intent: "view", replace: !!memory.fileNavigation };
}

export function showFile(target: FileTarget, line?: number, keepSearch = false) {
  navigateWorkspace(target, "files", {
    file: target.path,
    line,
    folder: parentPath(target.path),
    draft: undefined,
    search: keepSearch || undefined,
    reveal: undefined,
  });
}

export function showDraft(draft: Draft, options: NavigationOptions = {}) {
  navigateWorkspace(
    draft,
    "files",
    {
      file: draft.path || undefined,
      line: undefined,
      draft: draft.id,
      folder: draft.path ? parentPath(draft.path) : draft.untitled?.folder,
      search: undefined,
      reveal: undefined,
    },
    options,
  );
}
export function syncDraftPath(draft: Draft) {
  const route = currentRoute();
  if (
    isWorkspaceRoute(route, draft) &&
    route.query.draft === draft.id &&
    route.query.file !== (draft.path || undefined)
  )
    updateWorkspaceQuery(
      draft,
      {
        file: draft.path || undefined,
        folder: draft.path ? parentPath(draft.path) : draft.untitled?.folder,
      },
      { replace: true },
    );
}

export interface HistoricalFileLocation extends FileTarget {
  draftId?: string;
  sessionId: string;
  kind: "origin" | "preview" | "document";
  entryKey?: string;
}

type FileNavigationDestination = FileTarget & { draftId?: string; entryKey: string };

function locationRequest(restoreReading: boolean) {
  const location = history.state?.fileNavigation as HistoricalFileLocation | undefined;
  return location && { ...location, requestId: newId(), restoreReading };
}

export function useHistoricalFileLocation() {
  const [location, setLocation] = useState(() => locationRequest(true));
  useEffect(() => {
    const listener = (event: PopStateEvent) => {
      const intent = navigationIntent(event);
      if (intent !== "view") setLocation(locationRequest(intent !== "lookup"));
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  return location;
}

export function beginFileNavigation(
  target: WorkspaceTarget,
  navigation: { id: string; origin: { path: string; draftId: string } },
) {
  const { origin } = navigation;
  const fileNavigation: HistoricalFileLocation = {
    ...target,
    path: origin.path,
    draftId: origin.draftId,
    sessionId: navigation.id,
    kind: "origin",
  };
  history.replaceState({ ...history.state, fileNavigation }, "");
}

export function clearFileNavigationHistory() {
  if (!history.state?.fileNavigation) return;
  const state = { ...history.state };
  delete state.fileNavigation;
  history.replaceState(state, "");
}

function enterFileNavigation(
  sessionId: string,
  entryKey: string,
  destination?: FileNavigationDestination,
) {
  const current = history.state?.fileNavigation as HistoricalFileLocation;
  const fileNavigation: HistoricalFileLocation = {
    ...(destination ?? current),
    sessionId,
    entryKey,
    kind: destination ? "document" : "preview",
  };
  const path = destination
    ? workspaceDestination(destination, "files", {
        file: destination.path,
        draft: destination.draftId,
        line: undefined,
        folder: parentPath(destination.path),
        reveal: undefined,
      })
    : undefined;
  const state = { ...(destination ? {} : history.state), fileNavigation };
  // One origin entry plus one candidate slot: the first candidate pushes, later ones replace.
  if (current?.sessionId === sessionId && current.kind !== "origin")
    history.replaceState(state, "", path);
  else history.pushState(state, "", path);
  notifyNavigation("lookup");
}

export function previewFileLocation(sessionId: string, entryKey: string) {
  enterFileNavigation(sessionId, entryKey);
}

export function openFileLocation(destination: FileNavigationDestination, sessionId: string) {
  enterFileNavigation(sessionId, destination.entryKey, destination);
}

export function returnToFileOrigin(sessionId: string) {
  const current = history.state?.fileNavigation as HistoricalFileLocation | undefined;
  if (current?.sessionId !== sessionId || current.kind === "origin") return false;
  history.back();
  return true;
}
