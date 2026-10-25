import { expect, test } from "vitest";
import { parseDiff, type TokenNode } from "react-diff-view";
import { codeLanguage } from "../src/lib/code-language";
import { diffTokens } from "../src/git/highlight";
import { inlineDiff } from "../src/git/inline-diff";

const text = (tokens: TokenNode[]) => tokens.map((token) => token.value ?? "").join("");

test("language matching recognizes nested special filenames and leaves unknown names plain", () => {
  expect(codeLanguage("deploy/Dockerfile")?.name).toBe("Dockerfile");
  expect(codeLanguage("native/CMakeLists.txt")?.name).toBe("CMake");
  expect(codeLanguage("data.unknown-extension")).toBeNull();
});

test("both layouts preserve each side's source and use its filename after a rename", async () => {
  const patch = [
    "diff --git a/old.js b/new.py",
    "--- a/old.js",
    "+++ b/new.py",
    "@@ -1,4 +1,4 @@",
    "-// old comment",
    "+# new comment",
    " ",
    "-const message = `中文 😀`;",
    "+message = '中文 😀'",
    " \t",
    "",
  ].join("\n");
  for (const options of [undefined, { nearbySequences: "zip" as const }]) {
    const file = parseDiff(patch, options)[0]!;
    const tokens = diffTokens(
      file,
      await codeLanguage(file.oldPath)!.load(),
      await codeLanguage(file.newPath)!.load(),
    );
    expect(tokens.old.map(text).join("\n")).toBe(
      "// old comment\n\nconst message = `中文 😀`;\n\t",
    );
    expect(tokens.new.map(text).join("\n")).toBe("# new comment\n\nmessage = '中文 😀'\n\t");
    expect(tokens.old[0]!.some((token) => token.className === "tok-comment")).toBe(true);
    expect(tokens.new[0]!.some((token) => token.className === "tok-comment")).toBe(true);
    expect(diffTokens(file).new.map(text)).toEqual(tokens.new.map(text));
  }
});

test("multiline syntax stays within its hunk without leaking across missing context", async () => {
  const file = parseDiff(
    [
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,2 +1,2 @@",
      " /* open comment",
      "-const old = 1;",
      "+const next = 2;",
      "@@ -20 +20 @@",
      "-const other = 1;",
      "+const other = 2;",
      "",
    ].join("\n"),
  )[0]!;
  const support = await codeLanguage("a.js")!.load();
  const tokens = diffTokens(file, support, support);
  expect(tokens.new[1]!.some((token) => token.className === "tok-comment")).toBe(true);
  expect(tokens.new[19]!.some((token) => token.className === "tok-keyword")).toBe(true);
  expect(text(tokens.new[19]!)).toBe("const other = 2;");
});

test("inline emphasis preserves text and syntax colors while covering complete graphemes", async () => {
  const old = 'const message = "👩🏽‍💻 é";';
  const next = 'const message = "👩🏻‍💻 è";';
  const file = parseDiff(
    [
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-" + old,
      "+" + next,
      "",
    ].join("\n"),
  )[0]!;
  const inline = file.hunks.map(inlineDiff);
  for (const support of [undefined, await codeLanguage("a.js")!.load()]) {
    const tokens = diffTokens(file, support, support, inline);
    expect(text(tokens.old[0]!)).toBe(old);
    expect(text(tokens.new[0]!)).toBe(next);
    for (const [side, emoji, combining] of [
      ["old", "👩🏽‍💻", "é"],
      ["new", "👩🏻‍💻", "è"],
    ] as const) {
      const marked = tokens[side][0]!.filter((token) => token.className?.includes("inline-edit"));
      expect(text(marked)).toContain(emoji);
      expect(text(marked)).toContain(combining);
      if (support) {
        expect(marked.every((token) => token.className.includes("tok-string"))).toBe(true);
        expect(
          tokens[side][0]!.some(
            (token) => token.className === "tok-keyword" && token.value === "const",
          ),
        ).toBe(true);
      }
    }
  }
});

test("whole-line additions, deletions and actual empty lines keep only the row emphasis", () => {
  for (const [old, next] of [
    [[], ["", "newCall();"]],
    [["", "oldCall();"], []],
  ]) {
    const file = parseDiff(
      [
        "diff --git a/a.js b/a.js",
        "--- a/a.js",
        "+++ b/a.js",
        `@@ -1,${old!.length} +1,${next!.length} @@`,
        ...old!.map((line) => "-" + line),
        ...next!.map((line) => "+" + line),
        "",
      ].join("\n"),
    )[0]!;
    const tokens = diffTokens(file, undefined, undefined, file.hunks.map(inlineDiff));
    expect(tokens.old.map(text)).toEqual(old);
    expect(tokens.new.map(text)).toEqual(next);
    const populated = old!.length ? tokens.old : tokens.new;
    expect(populated[0]).toEqual([{ type: "empty" }]);
    expect(populated.flat().some((token) => token.className?.includes("inline-edit"))).toBe(false);
  }
});
