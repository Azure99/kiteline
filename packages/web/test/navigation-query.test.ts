import { EditorSelection, EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { codeLanguage } from "../src/lib/code-language";
import { navigationQuery } from "../src/files/navigation-query";

test("an explicit selection preserves punctuation and takes priority over the cursor word", () => {
  const doc = "call(foo-bar?);";
  const state = EditorState.create({ doc, selection: { anchor: 13, head: 5 } });
  expect(navigationQuery(state)).toBe("foo-bar?");
});

test("cursor queries use the current CodeMirror state and its loaded language boundaries", async () => {
  const language = await codeLanguage("sample.js")!.load();
  let state = EditorState.create({
    doc: "$value 中文名称 cafe\u0301",
    extensions: language,
  });
  expect(navigationQuery(state)).toBe("$value");
  state = state.update({ selection: EditorSelection.cursor(8) }).state;
  expect(navigationQuery(state)).toBe("中文名称");
  state = state.update({ selection: EditorSelection.cursor(state.doc.length) }).state;
  expect(navigationQuery(state)).toBe("cafe\u0301");
});

test.each([
  ["no word", "();", 1, 1],
  ["empty text", "", 0, 0],
  ["multiple lines", "first\nsecond", 0, 8],
  ["query over the search limit", "x".repeat(4097), 0, 4097],
  ["NUL", "one\0two", 0, 7],
] as const)("%s does not produce a search query", (_, doc, anchor, head) => {
  const state = EditorState.create({ doc, selection: { anchor, head } });
  expect(navigationQuery(state)).toBeUndefined();
});
