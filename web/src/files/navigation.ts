import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
} from "../lib/navigation";
import { isDirty, type Draft, type DraftStore } from "./drafts";
import { parentPath } from "./paths";
import type { FileTarget } from "./content";

export function showFile(target: FileTarget) {
  navigateWorkspace(target, "files", {
    file: target.path,
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
      file: draft.path,
      draft: draft.id,
      folder: parentPath(draft.path),
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
    route.query.file !== draft.path
  )
    updateWorkspaceQuery(draft, { file: draft.path, folder: parentPath(draft.path) }, true);
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
    else updateWorkspaceQuery(draft, { file: next?.path, draft: next?.id }, true);
  }
  store.close(draft);
}
export function requestCloseDraft(store: DraftStore, draft: Draft) {
  if (isDirty(draft)) store.setClosing(draft.id);
  else closeDraft(store, draft);
}
