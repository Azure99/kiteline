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
  { byteColumn, wholeWord = false }: SearchCoordinates = {},
) {
  if (!query) return;
  if (raw.startsWith("\uFEFF")) raw = raw.slice(1);
  let start = 0;
  for (let number = 1; number < line; number++) {
    start = raw.indexOf("\n", start) + 1;
    if (!start) return;
  }
  const end = raw.indexOf("\n", start);
  const rawLine = raw.slice(start, end < 0 ? undefined : end);
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
  const prefix = raw.slice(0, start + offset);
  let number = 1;
  let lineStart = 0;
  for (const match of prefix.matchAll(/\r\n?|\n/g)) {
    number++;
    lineStart = match.index + match[0].length;
  }
  return { line: number, column: prefix.length - lineStart };
}
