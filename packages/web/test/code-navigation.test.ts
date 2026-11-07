import { expect, test, vi } from "vitest";
import { diff } from "@codemirror/merge";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import type { SearchMatch, SearchResult } from "@kiteline/shared/protocol";
import { codeLanguage } from "../src/lib/code-language";
import { inspectNavigation } from "../src/files/navigation-candidates";
import {
  navigationSearchEntries as searchEntries,
  type CodeNavigationRequest,
} from "../src/files/code-navigation";

import { NavigationDocument } from "../src/files/navigation-tracker";

vi.mock("../src/files/text-diff", () => ({
  diffText: async (before: string, after: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Text comparison cancelled", "AbortError");
    return diff(before, after);
  },
}));

interface FixtureDraft {
  state: EditorState;
  document: NavigationDocument;
}

function navigationSearchEntries(
  result: SearchResult | undefined,
  navigation?: { request: CodeNavigationRequest; draft: FixtureDraft },
) {
  return searchEntries(
    result,
    navigation && {
      request: navigation.request,
      positions: {
        local: (range) => navigation.draft.document.local(range),
        disk: (match) =>
          match.path === navigation.request.origin.path
            ? navigation.draft.document.disk(match, navigation.request.context.query)
            : { status: "unmapped" },
      },
    },
  );
}

function edit(draft: FixtureDraft, changes: ChangeSpec): FixtureDraft {
  const transaction = draft.state.update({ changes });
  draft.document.update([transaction], transaction.newDoc);
  return { ...draft, state: transaction.state };
}

function result(matches: SearchResult["matches"], truncated = false): SearchResult {
  return { matches, truncated };
}

function matchesFor(text: string, query = "name", path = "main.ts"): SearchMatch[] {
  return text.split("\n").flatMap((text, index) => {
    const ranges: [number, number][] = [...text.matchAll(new RegExp(query, "g"))].map((match) => [
      match.index,
      match.index + query.length,
    ]);
    return ranges.length ? [{ path, line: index + 1, text, ranges }] : [];
  });
}

async function fixture(
  base: string,
  current = base,
  query = "name",
  caret = current.lastIndexOf(query),
) {
  const state = EditorState.create({
    doc: current,
    selection: { anchor: caret },
    extensions: await codeLanguage("main.ts")!.load(),
  });
  const line = state.doc.lineAt(caret);
  const request: CodeNavigationRequest = {
    initialGroup: "definitions",
    context: inspectNavigation(state, query),
    origin: {
      path: "main.ts",
      draftId: "draft-main",
      line: line.number,
      column: caret - line.from,
    },
  };
  const document = new NavigationDocument("draft-main", state.doc, base, base);
  await document.prepareDisk(new AbortController().signal);
  return { request, draft: { state, document } };
}

test("one row becomes mutually exclusive occurrences while ordinary search stays by row", async () => {
  const text = "const name = name;";
  const { request, draft } = await fixture(text);
  const disk = result(matchesFor(text));
  const entries = navigationSearchEntries(disk, { request, draft });
  expect(entries.map(({ match, group, isOrigin }) => [match.ranges, group, isOrigin])).toEqual([
    [[[6, 10]], "definitions", false],
    [[[13, 17]], "occurrences", true],
  ]);
  expect(navigationSearchEntries(disk)).toMatchObject([{ match: disk.matches[0], source: "disk" }]);
  expect(disk.matches[0]!.ranges).toEqual([
    [6, 10],
    [13, 17],
  ]);
});

test("a disk declaration rule classifies its precise range without promoting the same-line use", async () => {
  const { request, draft } = await fixture("name();");
  const disk = result(matchesFor("const name = name;", "name", "other.ts"));
  expect(
    navigationSearchEntries(disk, { request, draft }).map(({ match, group, reason }) => [
      match.path,
      match.ranges![0]![0],
      group,
      reason,
    ]),
  ).toEqual([
    ["other.ts", 6, "definitions", "possible-definition"],
    ["main.ts", 0, "occurrences", "current-file"],
    ["other.ts", 13, "occurrences", "name-match"],
  ]);
});

test("disk declaration evidence promotes a duplicate while retaining the draft origin display", async () => {
  const base = "const name = 1;\nname();";
  const current = "/* */ name = 1;\nname();";
  const { request, draft } = await fixture(base, current, "name", 6);
  const initial = navigationSearchEntries(undefined, { request, draft })[0]!;
  expect(initial).toMatchObject({ reason: "current-file", group: "occurrences", isOrigin: true });
  const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft });
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({
    key: initial.key,
    match: { line: 1, text: "/* */ name = 1;", ranges: [[6, 10]] },
    source: "draft",
    draftId: "draft-main",
    reason: "possible-definition",
    group: "definitions",
    isOrigin: true,
  });
});

test("same-line parameters and properties keep independent groups", async () => {
  const text = "function use(name: { name: string }) { return name; }";
  const { request, draft } = await fixture(text);
  const entries = navigationSearchEntries(result(matchesFor(text)), { request, draft });
  expect(entries.map(({ match, group }) => [match.ranges![0]![0], group])).toEqual([
    [13, "definitions"],
    [21, "occurrences"],
    [46, "occurrences"],
  ]);
});

test("a non-member query does not promote either untagged destructuring or the adjacent property", async () => {
  const text = "function use({ name }: { name: string }) { return name; }";
  const { request, draft } = await fixture(text);
  const entries = navigationSearchEntries(result(matchesFor(text)), { request, draft });
  expect(entries).toHaveLength(3);
  expect(entries.every((entry) => entry.group === "occurrences")).toBe(true);
});

test.each([
  ["inserted lines", "// unsaved\nconst name = 1;\nname();"],
  ["new local definition", "const name = 2;\nconst name = 1;\nname();"],
  ["deleted prefix", "const name = 1;\nname();"],
])("unchanged disk ranges deduplicate with current draft through %s", async (_, current) => {
  const base = "// prefix\nconst name = 1;\nname();";
  const { request, draft } = await fixture(base, current);
  const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft });
  expect(entries).toHaveLength(current.startsWith("const name = 2;") ? 3 : 2);
  expect(entries.filter((entry) => entry.isOrigin)).toHaveLength(1);
  expect(
    entries
      .filter((entry) => entry.group === "definitions")
      .every((entry) => entry.source === "draft"),
  ).toBe(true);
});

test.each([
  ["renamed", "const other = 1;\nname();"],
  ["deleted", "name();"],
])(
  "a %s disk declaration remains a separate disk occurrence when its range cannot map",
  async (_, current) => {
    const base = "const name = 1;\nname();";
    const { request, draft } = await fixture(base, current);
    const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "disk", group: "definitions", isOrigin: false });
    expect(entries[1]).toMatchObject({ source: "draft", group: "occurrences", isOrigin: true });
  },
);

test("new unsaved origin is retained, while other new plain text uses are not a full-draft search", async () => {
  const base = "const name = 1;";
  const current = base + "\nname();\nname();";
  const { request, draft } = await fixture(base, current);
  const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft });
  expect(entries.map(({ match, isOrigin }) => [match.line, isOrigin])).toEqual([
    [1, false],
    [3, true],
  ]);
});

test("identical repeated blocks do not collapse merely because their text is equal", async () => {
  const base = "const name = 1;\nconst name = 1;\nname();";
  const current = "const name = 1;\n" + base;
  const { request, draft } = await fixture(base, current);
  const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft });
  expect(entries.map(({ match, group }) => [match.line, group])).toEqual([
    [1, "definitions"],
    [2, "definitions"],
    [3, "definitions"],
    [4, "occurrences"],
  ]);
});

test("an interior caret marks only the actual same-line occurrence and keeps the return caret", async () => {
  const text = "name(name);";
  const { request, draft } = await fixture(text, text, "name", 7);
  const entries = navigationSearchEntries(result(matchesFor(text)), { request, draft });
  expect(entries.map(({ match, isOrigin }) => [match.ranges![0]![0], isOrigin])).toEqual([
    [0, false],
    [5, true],
  ]);
  expect(request.origin.column).toBe(7);
  expect(request.context.queryRange.column).toBe(5);
});

test("group location hints do not change the fixed-origin ranking or returned set", async () => {
  const { request, draft } = await fixture("name();");
  const disk = result([
    ...matchesFor("name();", "name", "far/name.ts"),
    ...matchesFor("const name = 1;", "name", "near.ts"),
    ...matchesFor("name();"),
  ]);
  expect(
    navigationSearchEntries(disk, { request: { ...request, initialGroup: "occurrences" }, draft }),
  ).toEqual(navigationSearchEntries(disk, { request, draft }));
});

test("a truncated line without visible ranges keeps its byte-coordinate location", async () => {
  const { request, draft } = await fixture("name();");
  const disk = result(
    [
      {
        path: "long.ts",
        line: 1,
        text: "中文".repeat(100),
        ranges: [],
        byteColumn: 6601,
        truncated: true,
      },
    ],
    true,
  );
  const entries = navigationSearchEntries(disk, { request, draft });
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({
    source: "disk",
    group: "occurrences",
    match: { ranges: [], byteColumn: 6601, truncated: true },
  });
  expect(disk.truncated).toBe(true);
});

test("a long-line first byte-coordinate hit can deduplicate with the precise draft origin", async () => {
  const raw = "中文".repeat(1100) + " name name";
  const { request, draft } = await fixture(raw, raw, "name", 2202);
  const disk = result(
    [
      {
        path: "main.ts",
        line: 1,
        text: raw.slice(0, 100),
        ranges: [],
        byteColumn: 6601,
        truncated: true,
      },
    ],
    true,
  );
  const entries = navigationSearchEntries(disk, { request, draft });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ isOrigin: true, match: { ranges: [[2201, 2205]] } });
  expect(disk.truncated).toBe(true);
});

test.each(["", "// already dirty\n"])(
  "an active lookup maps captured definitions and origin into the subsequently edited draft: %s",
  async (prefix) => {
    const base = "const name = 1;\nname();";
    const { request, draft } = await fixture(base, prefix + base);
    const disk = result(matchesFor(base));
    expect(navigationSearchEntries(disk, { request, draft })).toHaveLength(2);
    const edited = edit(draft, { from: 0, insert: "// added\n" });
    const entries = navigationSearchEntries(disk, { request, draft: edited });
    expect(
      entries.map(({ match, source, group, isOrigin }) => [match.line, source, group, isOrigin]),
    ).toEqual([
      [prefix ? 3 : 2, "draft", "definitions", false],
      [prefix ? 4 : 3, "draft", "occurrences", true],
    ]);
  },
);

test("later edits always map from the captured lookup text, without applying an earlier offset twice", async () => {
  const base = "const name = 1;\nname();";
  const { request, draft } = await fixture(base);
  const disk = result(matchesFor(base));
  const once = edit(draft, { from: 0, insert: "// first\n" });
  navigationSearchEntries(disk, { request, draft: once });
  const twice = edit(once, { from: 0, insert: "// second\n" });
  const entries = navigationSearchEntries(disk, { request, draft: twice });
  expect(entries.map(({ match, isOrigin }) => [match.line, isOrigin])).toEqual([
    [3, false],
    [4, true],
  ]);
  expect(request.context.queryRange.line).toBe(2);
  expect(request.context.definitions[0]!.line).toBe(1);
});

test.each(["other();", ""])(
  "an origin changed during lookup is not reassigned to an old or unrelated position: %s",
  async (replacement) => {
    const base = "const name = 1;\nname();";
    const { request, draft } = await fixture(base);
    const edited = edit(draft, { from: 16, to: base.length, insert: replacement });
    const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft: edited });
    expect(entries).toHaveLength(1);
    expect(entries.some((entry) => entry.isOrigin)).toBe(false);
    expect(entries.find((entry) => entry.match.line === 2)).toBeUndefined();
  },
);

test("a definition renamed during lookup loses both identities tied to its deleted characters", async () => {
  const base = "const name = 1;\nname();";
  const { request, draft } = await fixture(base);
  const edited = edit(draft, { from: 6, to: 10, insert: "other" });
  const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft: edited });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ source: "draft", group: "occurrences", isOrigin: true });
});

test("mapped disk occurrences display and open in the same current draft coordinate domain", async () => {
  const base = "const name = 1;\nname(1);\nname(2);\nname(3);";
  const { request, draft } = await fixture(base, "// inserted\n" + base);
  const entries = navigationSearchEntries(result(matchesFor(base)), { request, draft });
  expect(
    entries.map(({ match, source, draftId, isOrigin }) => [
      match.line,
      match.text,
      source,
      draftId,
      isOrigin,
    ]),
  ).toEqual([
    [2, "const name = 1;", "draft", "draft-main", false],
    [3, "name(1);", "draft", "draft-main", false],
    [4, "name(2);", "draft", "draft-main", false],
    [5, "name(3);", "draft", "draft-main", true],
  ]);
});

test.each(["", "// already dirty\n"])(
  "non-member property definitions stay in other occurrences before and during draft edits: %s",
  async (prefix) => {
    const base = "class Item {\n  name = name;\n}\nconst name = 1;\nname();";
    const { request, draft } = await fixture(base, prefix + base);
    const disk = result(matchesFor(base));
    const expectGroups = (current: FixtureDraft) => {
      const entries = navigationSearchEntries(disk, { request, draft: current });
      const properties = entries.filter((entry) => entry.match.text?.includes("name = name"));
      expect(properties).toMatchObject([
        { group: "occurrences", match: { ranges: [[2, 6]] } },
        { group: "occurrences", match: { ranges: [[9, 13]] } },
      ]);
      expect(entries.filter((entry) => entry.group === "definitions")).toMatchObject([
        { match: { text: "const name = 1;", ranges: [[6, 10]] } },
      ]);
      expect(entries).toHaveLength(4);
    };
    expectGroups(draft);
    expectGroups(edit(draft, { from: 0, insert: "// later\n" }));
  },
);

test("member lookup retains a class field definition and cross-file assignment rules remain available", async () => {
  const text = 'class Item {\n  name = "";\n  read() { return this.name; }\n}';
  const { request, draft } = await fixture(text);
  const entries = navigationSearchEntries(
    result([...matchesFor(text), ...matchesFor('name = "";', "name", "other.ts")]),
    { request, draft },
  );
  expect(entries.filter((entry) => entry.group === "definitions")).toMatchObject([
    { match: { path: "main.ts", line: 2, ranges: [[2, 6]] } },
    { match: { path: "other.ts", line: 1, ranges: [[0, 4]] } },
  ]);
});

test("a selected local candidate keeps its identity through disk completion and result reordering", async () => {
  const base = "const name = 1;\nconst name = 2;\nname();";
  const { request, draft } = await fixture(base);
  const local = navigationSearchEntries(undefined, { request, draft });
  const selected = local.find((entry) => entry.match.line === 2)!;
  const disk = result(matchesFor(base));
  const completed = navigationSearchEntries(disk, { request, draft });
  expect(completed.find((entry) => entry.key === selected.key)?.match.line).toBe(2);
  expect(completed).toHaveLength(3);

  const edited = edit(draft, { from: 6, to: 10 });
  const reordered = navigationSearchEntries(disk, { request, draft: edited });
  const retained = reordered.find((entry) => entry.key === selected.key)!;
  expect(retained.match.line).toBe(2);
  expect(retained.group).toBe("definitions");
  expect(reordered.indexOf(retained)).not.toBe(
    completed.findIndex((entry) => entry.key === selected.key),
  );
  expect(reordered.filter((entry) => entry.isOrigin)).toHaveLength(1);
  expect(new Set(reordered.map((entry) => entry.key)).size).toBe(reordered.length);
});

test("a removed local candidate does not transfer its identity to the stale disk occurrence", async () => {
  const base = "const name = 1;\nname();";
  const { request, draft } = await fixture(base);
  const disk = result(matchesFor(base));
  const selected = navigationSearchEntries(disk, { request, draft })[0]!;
  const edited = edit(draft, { from: 6, to: 10 });
  const entries = navigationSearchEntries(disk, { request, draft: edited });
  expect(entries.find((entry) => entry.key === selected.key)).toBeUndefined();
  expect(entries.find((entry) => entry.match.line === 1)).toBeUndefined();
});
