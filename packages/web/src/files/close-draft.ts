import { currentRoute, isWorkspaceRoute, updateWorkspaceQuery } from "../lib/navigation";
import { isDirty, type Draft, type DraftStore } from "./drafts";

export function completeDraftClose(store: DraftStore, draft: Draft) {
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
  else completeDraftClose(store, draft);
}
