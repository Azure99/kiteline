import { isDirty, type Draft } from "../files/drafts";
import { childPath } from "../files/paths";

export function hasUnsavedDraft(
  drafts: Draft[],
  target: { deviceId: string; workspaceId: string },
  repoPath: string,
  paths: string[],
) {
  return drafts.some(
    (draft) =>
      draft.deviceId === target.deviceId &&
      draft.workspaceId === target.workspaceId &&
      isDirty(draft) &&
      paths.some((path) => draft.path === childPath(repoPath, path)),
  );
}
