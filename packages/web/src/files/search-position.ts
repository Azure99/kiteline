import type { Text } from "@codemirror/state";
import type { Change } from "@codemirror/merge";

type Position = { line: number; column: number };
type SearchCoordinates = { byteColumn?: number; wholeWord?: boolean };

// Content search results use ripgrep's coordinates: LF line numbers and UTF-16 columns in that
// raw line. The editor also breaks lines at lone CRs (docs/design/files.md#文本格式), so map them
// through the draft's raw base text. Without a column, because the hit lies beyond the returned
// snippet, use rg's byte column so the browser does not repeat its Unicode word-boundary rules.
export function searchPosition(
  raw: string,
  line: number,
  query: string,
  column?: number,
  coordinates: SearchCoordinates = {},
) {
  return searchPositionFinder(raw)(line, query, column, coordinates);
}

export function searchPositionFinder(raw: string) {
  if (raw.startsWith("\uFEFF")) raw = raw.slice(1);
  const rawLines = [0];
  const editorLines = [0];
  for (const match of raw.matchAll(/\r\n?|\n/g)) {
    const next = match.index + match[0].length;
    editorLines.push(next);
    if (match[0].endsWith("\n")) rawLines.push(next);
  }
  return (
    line: number,
    query: string,
    column?: number,
    { byteColumn, wholeWord = false }: SearchCoordinates = {},
  ): Position | undefined => {
    if (!query) return;
    const start = rawLines[line - 1];
    if (start === undefined) return;
    const rawLine = raw.slice(
      start,
      rawLines[line] === undefined ? undefined : rawLines[line]! - 1,
    );
    let offset = column;
    if (offset === undefined && byteColumn !== undefined) {
      const bytes = new TextEncoder().encode(rawLine);
      if (byteColumn > bytes.length) return;
      offset = new TextDecoder().decode(bytes.subarray(0, byteColumn)).length;
    }
    // Substring searches can locate their first hit; whole-word searches require rg coordinates.
    if (offset === undefined) {
      if (wholeWord) return;
      offset = rawLine.indexOf(query);
    }
    if (offset < 0) return;
    const absolute = start + offset;
    let low = 0;
    let high = editorLines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (editorLines[middle]! <= absolute) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: absolute - editorLines[low]! };
  };
}

// Both texts use the editor's normalized line endings. Map only an unchanged hit;
// a changed interval still uses the caller's existing in-file Find fallback.
export function mapSearchPosition(
  base: Text,
  current: Text,
  position: Position | undefined,
  query: string,
  changes: readonly Change[],
) {
  if (!position) return;
  return searchPositionMapper(base, current, changes)(position, query);
}

export function searchPositionMapper(base: Text, current: Text, changes: readonly Change[]) {
  return (position: Position | undefined, query: string): Position | undefined => {
    if (!position || position.line > base.lines) return;
    const line = base.line(position.line);
    const from = line.from + position.column;
    const to = from + query.length;
    if (position.column > line.length || base.sliceString(from, to) !== query) return;
    let offset = 0;
    for (const change of changes) {
      if (change.toA <= from) offset = change.toB - change.toA;
      else if (change.fromA < to) return;
      else break;
    }
    const mapped = from + offset;
    const mappedLine = current.lineAt(mapped);
    return { line: mappedLine.number, column: mapped - mappedLine.from };
  };
}
