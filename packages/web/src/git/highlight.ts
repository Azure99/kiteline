import { highlightCode, classHighlighter } from "@lezer/highlight";
import type { LanguageSupport } from "@codemirror/language";
import type { FileData, HunkTokens, TokenNode } from "react-diff-view";
import type { InlineHunk, InlineRange } from "./inline-diff";
function lines(text: string, support?: LanguageSupport): TokenNode[][] {
  if (!support)
    return text
      .split("\n")
      .map((value) => (value ? [{ type: "text", value }] : [{ type: "empty" }]));
  const result: TokenNode[][] = [[]];
  highlightCode(
    text,
    support.language.parser.parse(text),
    classHighlighter,
    (value, className) =>
      result[result.length - 1]!.push(
        className ? { type: "syntax", className, value } : { type: "text", value },
      ),
    () => {
      result.push([]);
    },
  );
  return result.map((line) => (line.length ? line : [{ type: "empty" }]));
}

function markInline(tokens: TokenNode[], ranges?: InlineRange[]) {
  if (!ranges?.length) return tokens;
  const result: TokenNode[] = [];
  let offset = 0;
  for (const token of tokens) {
    const value = token.value!;
    const end = offset + value.length;
    let position = offset;
    for (const range of ranges) {
      const from = Math.max(position, range.from);
      const to = Math.min(end, range.to);
      if (from >= to) continue;
      if (position < from)
        result.push({ ...token, value: value.slice(position - offset, from - offset) });
      result.push({
        type: "syntax",
        className: token.className ? `${token.className} inline-edit` : "inline-edit",
        value: value.slice(from - offset, to - offset),
      });
      position = to;
    }
    if (position < end) result.push({ ...token, value: value.slice(position - offset) });
    offset = end;
  }
  return result;
}
export function diffTokens(
  file: FileData,
  oldSupport?: LanguageSupport,
  newSupport?: LanguageSupport,
  inline?: InlineHunk[],
): HunkTokens {
  const tokens: HunkTokens = { old: [], new: [] };
  for (const [hunkIndex, hunk] of file.hunks.entries())
    for (const side of ["old", "new"] as const) {
      const changes = hunk.changes.filter(
        (change) => change.type !== (side === "old" ? "insert" : "delete"),
      );
      const colored = lines(
        changes.map((change) => change.content).join("\n"),
        side === "old" ? oldSupport : newSupport,
      );
      changes.forEach((change, index) => {
        const number =
          change.type === "normal"
            ? side === "old"
              ? change.oldLineNumber
              : change.newLineNumber
            : change.lineNumber;
        tokens[side][number - 1] = markInline(colored[index]!, inline?.[hunkIndex]?.[side][number]);
      });
    }
  return tokens;
}
