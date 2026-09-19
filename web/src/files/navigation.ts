import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
} from "../lib/navigation";
import { isDirty, type Draft, type DraftStore } from "./drafts";
import { parentPath } from "./use-browser";

export function showDraft(draft: Draft, replace = false) {
  navigateWorkspace(
    draft,
    "files",
    {
      file: draft.path,
      draft: draft.id,
      folder: parentPath(draft.path),
      preview: undefined,
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
function clearDraftTarget(store: DraftStore, draft: Draft) {
  const route = currentRoute();
  if (
    isWorkspaceRoute(route, draft) &&
    !route.query.preview &&
    store.find({ ...draft, path: route.query.file ?? "" }, route.query.draft) === draft
  )
    updateWorkspaceQuery(draft, { file: undefined, draft: undefined, preview: undefined }, true);
}
export function closeDraft(store: DraftStore, draft: Draft) {
  clearDraftTarget(store, draft);
  store.close(draft);
}
export function requestCloseDraft(store: DraftStore, draft: Draft) {
  if (isDirty(draft)) {
    store.closing = draft.id;
    store.changed();
  } else closeDraft(store, draft);
}
