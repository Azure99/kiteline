import { expect, test } from "vitest";
import { decodeText } from "@kiteline/shared/protocol/text";
import { searchPosition } from "../src/files/search-position";

// Editor coordinates of the hit: the position in the decoded, LF-normalized text.
function editorAt(raw: string, line: number, column: number, query: string) {
  const { text } = decodeText(new TextEncoder().encode(raw));
  return text.split("\n")[line - 1]!.slice(column, column + query.length);
}

test.each([
  ["LF", "a\nb\n  HIT\n", 3, [2, 5], { line: 3, column: 2 }],
  ["CRLF", "a\r\nb\r\n  HIT\r\n", 3, [2, 5], { line: 3, column: 2 }],
  ["lone CR", "first\rHIT\rthird\r", 1, [6, 9], { line: 2, column: 0 }],
  ["mixed", "first\r\nsecond\rHIT\r\nlast\n", 2, [7, 10], { line: 3, column: 0 }],
  ["lone CRs on earlier lines", "0%\r50%\r100%\nERROR HIT\n", 2, [6, 9], { line: 4, column: 6 }],
  ["BOM", "\uFEFFfirst\rsecond\rHIT\r", 1, [13, 16], { line: 3, column: 0 }],
  ["UTF-16 columns", "😀\r中文 😀 HIT", 1, [9, 12], { line: 2, column: 6 }],
  ["CR followed by CRLF", "a\r\r\nHIT\n", 2, [0, 3], { line: 3, column: 0 }],
] as const)("%s ripgrep coordinates map to the editor hit", (_, raw, line, range, expected) => {
  const query = "HIT";
  expect(searchPosition(raw, line, query, range[0])).toEqual(expected);
  expect(editorAt(raw, expected.line, expected.column, query)).toBe(query);
});

test("a hit beyond the snippet uses the first occurrence in ripgrep's line", () => {
  const raw = `${"row\r".repeat(600)}HIT x HIT\rtail`;
  expect(searchPosition(raw, 1, "HIT")).toEqual({ line: 601, column: 0 });
  const long = `head\n${"v=1;".repeat(1000)}HIT;HIT\nend\n`;
  expect(searchPosition(long, 2, "HIT")).toEqual({ line: 2, column: 4000 });
});

test("stale coordinates leave the decision to the editor's text check", () => {
  expect(searchPosition("one\ntwo\n", 5, "HIT")).toBeUndefined();
  expect(searchPosition("one\ntwo\n", 2, "HIT")).toBeUndefined();
  expect(searchPosition("", 1, "")).toBeUndefined();
});
