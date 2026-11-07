import type { EditorState } from "@codemirror/state";

export function navigationQuery(state: EditorState): string | undefined {
  const selection = state.selection.main;
  const range = selection.empty ? state.wordAt(selection.head) : selection;
  if (!range) return;
  const query = state.sliceDoc(range.from, range.to);
  // Match the existing search query limit; a newline would become another ripgrep pattern.
  if (
    !query ||
    query.length > 4096 ||
    query.includes("\r") ||
    query.includes("\n") ||
    query.includes("\0")
  )
    return;
  return query;
}
