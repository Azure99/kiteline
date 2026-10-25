import { draftLabel } from "./draft-label";
import { isDirty, type Draft } from "./drafts";

export function codeLineReference(draft: Draft) {
  const state = draft.state!;
  const range = state.selection.main;
  const start = state.doc.lineAt(range.from);
  const end = range.empty ? start : state.doc.lineAt(range.to - 1);
  return [
    `Device: ${JSON.stringify(draft.deviceName)}`,
    `Workspace: ${JSON.stringify(draft.workspaceName)}`,
    draft.path
      ? `Workspace-relative file: ${JSON.stringify(draft.path)}`
      : `Untitled buffer: ${JSON.stringify(draftLabel(draft))}`,
    `Buffer ${start.number === end.number ? `line ${start.number}` : `lines ${start.number}-${end.number}`}${isDirty(draft) ? "; unsaved or unconfirmed" : ""}${draft.missing ? "; device file missing" : ""}`,
    ...state
      .sliceDoc(start.from, end.to)
      .split("\n")
      .map((line) => `> ${line}`),
  ].join("\n");
}
