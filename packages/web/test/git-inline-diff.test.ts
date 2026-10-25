import { expect, test } from "vitest";
import { parseDiff } from "react-diff-view";
import { inlineDiff } from "../src/git/inline-diff";

const file = (body: string[]) =>
  parseDiff(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", ...body, ""].join("\n"))[0]!;

test("a useCallback conversion aligns the unchanged calls despite the added parameter line", () => {
  // The conversion in 3a6c8a8f, terminal-view.tsx.
  const hunk = file([
    "@@ -221,10 +229,13 @@",
    "       setNotice(error);",
    "     }",
    "   }",
    "-  const auxiliary = (value: string) => {",
    "-    display.current?.key(value);",
    "-    if (!mobile) display.current?.focus();",
    "-  };",
    "+  const auxiliary = useCallback(",
    "+    (value: string) => {",
    "+      display.current?.key(value);",
    "+      if (!mobile) display.current?.focus();",
    "+    },",
    "+    [mobile],",
    "+  );",
    "   return (",
    "     <section",
    '       className="terminal-surface flex min-h-0 flex-1 flex-col"',
  ]).hunks[0]!;
  const rows = inlineDiff(hunk).rows.map((row) =>
    row.map((index) => {
      const change = index === null ? null : hunk.changes[index]!;
      return change?.type === "normal" ? null : (change?.lineNumber ?? null);
    }),
  );
  expect(rows).toContainEqual([225, 234]);
  expect(rows).toContainEqual([226, 235]);
  expect(rows).toContainEqual([null, 233]);
});

test.each([
  [[], ["", "newCall();"]],
  [["", "oldCall();"], []],
  [[""], ["", ""]],
  [
    ["if (a) {", "", "  run();", "}", "", "run();"],
    ["if (b) {", "", "  extra();", "  run();", "}", "", "run();"],
  ],
  [
    ["\tfoo();", "  bar();"],
    ["  extra();", "  foo();", "\tbar();"],
  ],
])(
  "alignment retains empty sides, whitespace and repeated lines in source order: %j → %j",
  (old, next) => {
    const hunk = file([
      `@@ -1,${old.length} +1,${next.length} @@`,
      ...old.map((line) => "-" + line),
      ...next.map((line) => "+" + line),
    ]).hunks[0]!;
    const result = inlineDiff(hunk);
    for (const [index, excluded] of [
      [0, "insert"],
      [1, "delete"],
    ] as const) {
      const projected = result.rows
        .map((row) => row[index])
        .filter((change) => change !== null)
        .map((change) => hunk.changes[change]!);
      expect(projected).toEqual(hunk.changes.filter((change) => change.type !== excluded));
      expect(projected.map((change) => change.content)).toEqual(index === 0 ? old : next);
    }
  },
);

test("context rows and hunk gaps keep their original correspondence and line numbers", () => {
  const value = file([
    "@@ -1,3 +1,4 @@",
    "-old();",
    "+new();",
    " ",
    "-run();",
    "+extra();",
    "+run();",
    "@@ -30 +40 @@",
    "-old();",
    "+new();",
  ]);
  for (const hunk of value.hunks) {
    const result = inlineDiff(hunk);
    const context = hunk.changes.findIndex((change) => change.type === "normal");
    if (context !== -1) expect(result.rows).toContainEqual([context, context]);
    for (const [side, excluded] of [
      [0, "insert"],
      [1, "delete"],
    ] as const)
      expect(result.rows.map((row) => row[side]).filter((index) => index !== null)).toEqual(
        hunk.changes.flatMap((change, index) => (change.type === excluded ? [] : [index])),
      );
  }
  expect(
    value.hunks[1]!.changes.map((change) => change.type !== "normal" && change.lineNumber),
  ).toEqual([30, 40]);
});
