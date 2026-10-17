import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
} from "../lib/navigation";
import { isDirty, type Draft, type DraftStore } from "./drafts";
import { parentPath } from "./paths";
import type { FileTarget } from "./content";

export function showFile(target: FileTarget, line?: number) {
  navigateWorkspace(target, "files", {
    file: target.path,
    line,
    folder: parentPath(target.path),
    draft: undefined,
    search: undefined,
    reveal: undefined,
  });
}

export function showDraft(draft: Draft, replace = false) {
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
    replace,
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
      true,
    );
}
export function closeDraft(store: DraftStore, draft: Draft) {
  const route = currentRoute();
  if (
    isWorkspaceRoute(route, draft) &&
    store.find({ ...draft, path: route.query.file ?? "" }, route.query.draft) === draft
  ) {
    const tabs = store
      .snapshot()
      .filter((item) => item.deviceId === draft.deviceId && item.workspaceId === draft.workspaceId);
    const index = tabs.indexOf(draft);
    const next = tabs[index + 1] ?? tabs[index - 1];
    if (next && route.tool === "files" && !route.query.search) showDraft(next, true);
    else updateWorkspaceQuery(draft, { file: next?.path || undefined, draft: next?.id }, true);
  }
  store.close(draft);
}
export function requestCloseDraft(store: DraftStore, draft: Draft) {
  if (isDirty(draft)) store.setClosing(draft.id);
  else closeDraft(store, draft);
}
