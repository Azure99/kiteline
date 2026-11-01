// Content search results use ripgrep's coordinates: LF line numbers and UTF-16 columns in that
// raw line. The editor also breaks lines at lone CRs (docs/design/files.md#文本格式), so map them
// through the draft's raw base text. Without a column, because the hit lies beyond the returned
// snippet, the query's first occurrence in the raw line is ripgrep's first submatch.
// This relies on the current case-sensitive --fixed-strings search contract.
export function searchPosition(raw: string, line: number, query: string, column?: number) {
  if (!query) return;
  if (raw.startsWith("\uFEFF")) raw = raw.slice(1);
  let start = 0;
  for (let number = 1; number < line; number++) {
    start = raw.indexOf("\n", start) + 1;
    if (!start) return;
  }
  const end = raw.indexOf("\n", start);
  const offset = column ?? raw.slice(start, end < 0 ? undefined : end).indexOf(query);
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
