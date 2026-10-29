import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
  type NavigationOptions,
} from "../lib/navigation";
import type { Draft } from "./drafts";
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
