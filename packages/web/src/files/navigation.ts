import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
  type NavigationOptions,
} from "../lib/navigation";
import { isDirty, type Draft, type DraftStore } from "./drafts";
import { parentPath } from "./paths";
import type { FileTarget } from "./content";

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
export function closeDraft(store: DraftStore, draft: Draft) {
  const route = currentRoute();
  if (
    isWorkspaceRoute(route, draft) &&
    store.find({ ...draft, path: route.query.file ?? "" }, route.query.draft) === draft
  ) {
    updateWorkspaceQuery(draft, { file: undefined, draft: undefined }, { replace: true });
  }
  store.close(draft);
}
export function requestCloseDraft(store: DraftStore, draft: Draft) {
  if (isDirty(draft)) store.setClosing(draft.id);
  else closeDraft(store, draft);
}
