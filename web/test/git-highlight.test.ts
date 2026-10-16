import { expect, test } from "vitest";
import { parseDiff, type TokenNode } from "react-diff-view";
import { codeLanguage } from "../src/lib/code-language";
import { diffTokens } from "../src/git/highlight";

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
