import { currentRoute, isWorkspaceRoute, updateWorkspaceQuery } from "../lib/navigation";
import { isDirty, type Draft, type DraftStore } from "./drafts";
import { clearFileNavigationHistory } from "./navigation";

export function completeDraftClose(store: DraftStore, draft: Draft) {
  const route = currentRoute();
  if (
    isWorkspaceRoute(route, draft) &&
    store.find({ ...draft, path: route.query.file ?? "" }, route.query.draft) === draft
  ) {
    clearFileNavigationHistory();
    updateWorkspaceQuery(
      draft,
      { file: undefined, draft: undefined },
      { replace: true, intent: "open" },
    );
  }
  store.close(draft);
}
export function requestCloseDraft(store: DraftStore, draft: Draft) {
  if (isDirty(draft)) store.setClosing(draft.id);
  else completeDraftClose(store, draft);
}
