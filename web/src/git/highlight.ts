import { highlightCode, classHighlighter } from "@lezer/highlight";
import type { LanguageSupport } from "@codemirror/language";
import type { FileData, HunkTokens, TokenNode } from "react-diff-view";
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
export function diffTokens(
  file: FileData,
  oldSupport?: LanguageSupport,
  newSupport?: LanguageSupport,
): HunkTokens {
  const tokens: HunkTokens = { old: [], new: [] };
  for (const hunk of file.hunks)
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
        tokens[side][number - 1] = colored[index]!;
      });
    }
  return tokens;
}
