import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { codeLanguage } from "../src/lib/code-language";
import {
  inspectNavigation,
  classifyNavigationMatches,
  compareNavigationMatches,
} from "../src/files/navigation-candidates";
import type { SearchMatch } from "@kiteline/shared/protocol";

async function javascript(doc: string, query: string) {
  return EditorState.create({
    doc,
    selection: { anchor: doc.lastIndexOf(query) },
    extensions: await codeLanguage("sample.ts")!.load(),
  });
}

function occurrences(path: string, line: number, text: string, query: string): SearchMatch[] {
  return [...text.matchAll(new RegExp(query, "g"))].map((match) => ({
    path,
    line,
    text,
    ranges: [[match.index, match.index + query.length]],
  }));
}

test("current draft definitions exclude imports and retain precise selection coordinates", async () => {
  let state = await javascript(
    'import { remote } from "./other";\nconst local = 1;\nlocal;',
    "local",
  );
  state = state.update({ changes: { from: 0, insert: "// unsaved\n" } }).state;
  expect(inspectNavigation(state, "local").definitions).toMatchObject([
    { line: 3, column: 6, endColumn: 11 },
  ]);
  expect(inspectNavigation(state, "remote").definitions).toEqual([]);
});

test("multiple declarations remain separate syntax candidates", async () => {
  const state = await javascript(
    "function a(value) {}\nfunction b(value) { return value; }",
    "value",
  );
  expect(inspectNavigation(state, "value").definitions).toHaveLength(2);
});

test("non-member property tags lose syntax priority without removing disk text", async () => {
  const state = await javascript(
    'import { result } from "./output";\nconst failure = { result: 0 };\nresult();',
    "result",
  );
  expect(inspectNavigation(state, "result").definitions).toEqual([]);
  const matches = occurrences("sample.ts", 2, "const failure = { result: 0 };", "result");
  expect(classifyNavigationMatches(matches, { query: "result", originPath: "sample.ts" })).toEqual([
    { match: matches[0], reason: "current-file" },
  ]);
});

test("property demotion retains member candidates and ordinary name definitions", async () => {
  const member = await javascript("class Runner { run() {} start() { this.run(); } }", "run");
  expect(inspectNavigation(member, "run").definitions).toMatchObject([{ column: 15 }]);
  const variable = await javascript("const result = 1;\nresult;", "result");
  expect(inspectNavigation(variable, "result").definitions).toMatchObject([{ line: 1, column: 6 }]);
});

test("an untagged destructured parameter does not gain its same-line type property's priority", async () => {
  const state = await javascript(
    "export async function terminalRpc(\n" +
      "  { sessions, metadata }: { sessions: Sessions; metadata: MetadataStore },\n" +
      ") {\n  return sessions.end();\n}",
    "sessions",
  );
  expect(inspectNavigation(state, "sessions").definitions).toEqual([]);
});

test("unknown languages retain text candidates without syntax priority", () => {
  expect(
    inspectNavigation(EditorState.create({ doc: "name = 1\nname" }), "name").definitions,
  ).toEqual([]);
});

test.each([
  ["const name = name;", 6, 13],
  ["  name: Type = name;", 2, 15],
  ["export function name(name) {}", 16, 21],
])("declaration rules classify only their captured name in %s", (text, definition, use) => {
  const ranked = classifyNavigationMatches(occurrences("other.ts", 1, text, "name"), {
    query: "name",
    originPath: "main.ts",
  });
  expect(ranked.map(({ match, reason }) => [match.ranges![0]![0], reason])).toEqual([
    [definition, "possible-definition"],
    [use, "name-match"],
  ]);
});

test("line rules retain their existing limits instead of recognizing every declaration", () => {
  const texts = [
    "const { name } = input;",
    "function use(name) {}",
    "obj.name = 1;",
    "name == value;",
    "name => value;",
    "// const name = 1;",
    "import { name } from './other';",
  ];
  const ranked = classifyNavigationMatches(
    texts.flatMap((text, index) => occurrences("other.ts", index + 1, text, "name")),
    { query: "name", originPath: "main.ts" },
  );
  expect(ranked.every(({ reason }) => reason === "name-match")).toBe(true);
});

test("rules precede other occurrences, with nearby rules and fixed-origin-file other occurrences first", () => {
  const matches = [
    ...occurrences("web/main.ts", 20, "target();", "target"),
    ...occurrences("agent/export.ts", 5, "export function target() {}", "target"),
    ...occurrences("web/sibling.ts", 3, "target = make();", "target"),
    ...occurrences("web/main.ts", 1, "function consume(target) {}", "target"),
    ...occurrences("web/lib/helper.ts", 2, "// target", "target"),
  ];
  const ranked = classifyNavigationMatches(matches, {
    query: "target",
    originPath: "web/main.ts",
  });
  ranked.sort((a, b) => compareNavigationMatches(a, b, "web/main.ts"));
  expect(ranked.map(({ match }) => `${match.path}:${match.line}`)).toEqual([
    "web/sibling.ts:3",
    "agent/export.ts:5",
    "web/main.ts:1",
    "web/main.ts:20",
    "web/lib/helper.ts:2",
  ]);
});

test("other occurrences use current file, nearby path segments, path, line and column", () => {
  const originPath = "packages/web/src/files/main.ts";
  const paths = [
    "packages/web-old/src/helper.ts",
    "packages/other/src/helper.ts",
    "packages/web/src/lib/helper.ts",
    "packages/web/src/files/sibling.ts",
    originPath,
  ];
  const ranked = classifyNavigationMatches(
    paths.flatMap((path) => occurrences(path, 1, "target(target)", "target").reverse()),
    { query: "target", originPath },
  );
  ranked.sort((a, b) => compareNavigationMatches(a, b, originPath));
  expect(ranked.map(({ match }) => [match.path, match.ranges![0]![0]])).toEqual(
    [originPath, paths[3], paths[2], paths[1], paths[0]].flatMap((path) => [
      [path, 0],
      [path, 7],
    ]),
  );
});

test("query range covers the word when the return caret is inside it", async () => {
  const state = (await javascript("const name = 1;\nname();", "name")).update({
    selection: { anchor: 18 },
  }).state;
  expect(inspectNavigation(state, "name").queryRange).toMatchObject({
    from: 16,
    to: 20,
    line: 2,
    column: 0,
    endColumn: 4,
  });
  expect(state.selection.main.head).toBe(18);
});

test("query range preserves a backward selection and member lookup uses its start", async () => {
  const doc = "const value = { name: 1 };\nvalue.name;";
  const from = doc.lastIndexOf("name");
  const state = (await javascript(doc, "name")).update({
    selection: { anchor: from + 4, head: from },
  }).state;
  const context = inspectNavigation(state, "name");
  expect(context.queryRange).toMatchObject({
    from,
    to: from + 4,
    line: 2,
    column: 6,
    endColumn: 10,
  });
  expect(context.definitions).toMatchObject([{ line: 1, column: 16 }]);
});
