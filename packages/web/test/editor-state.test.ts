import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { expect, test } from "vitest";
import { selectionForDocument } from "../src/files/editor-state";

test("a new source keeps each selection's line, column and direction within the new document", () => {
  const initial = EditorState.create({
    doc: "abcdef\nlong second\nlast line",
    extensions: EditorState.allowMultipleSelections.of(true),
  });
  const last = initial.doc.line(3).from;
  const state = initial.update({
    selection: EditorSelection.create(
      [EditorSelection.range(4, 1), EditorSelection.range(last + 4, last + 5)],
      1,
    ),
  }).state;
  const projected = selectionForDocument(state, Text.of(["xyz", "q"]));
  expect(projected.ranges.map(({ anchor, head }) => [anchor, head])).toEqual([
    [3, 1],
    [5, 5],
  ]);
  expect(projected.mainIndex).toBe(1);
});
