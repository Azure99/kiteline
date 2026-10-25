import { presentableDiff } from "@codemirror/merge";
import type { ChangeData, HunkData } from "react-diff-view";

export type InlineRange = { from: number; to: number };
export type InlineHunk = {
  rows: [number | null, number | null][];
  old: Record<number, InlineRange[]>;
  new: Record<number, InlineRange[]>;
};

function sideLines(hunk: HunkData, side: "old" | "new") {
  const lines: { change: ChangeData; index: number; from: number }[] = [];
  let from = 0;
  hunk.changes.forEach((change, index) => {
    if (change.type === (side === "old" ? "insert" : "delete")) return;
    lines.push({ change, index, from });
    from += change.content.length + 1;
  });
  return { lines, text: lines.map(({ change }) => change.content).join("\n") };
}
type Side = ReturnType<typeof sideLines>;

function lineAt(side: Side, position: number) {
  let low = 0;
  let high = side.lines.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (side.lines[middle]!.from <= position) low = middle;
    else high = middle;
  }
  return low;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeRanges(text: string, ranges: InlineRange[]) {
  const result: InlineRange[] = [];
  let rangeIndex = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    while (ranges[rangeIndex] && ranges[rangeIndex]!.to <= index) rangeIndex++;
    const range = ranges[rangeIndex];
    if (!range) break;
    const end = index + segment.length;
    if (range.from >= end) continue;
    const last = result[result.length - 1];
    if (last?.to === index) last.to = end;
    else result.push({ from: index, to: end });
  }
  // The existing row color already identifies an entirely changed line.
  return result.length === 1 && result[0]!.from === 0 && result[0]!.to === text.length
    ? []
    : result;
}

function lineRanges(side: Side, changes: InlineRange[]) {
  const ranges: Record<number, InlineRange[]> = {};
  for (const { from, to } of changes) {
    if (from === to) continue;
    for (let index = lineAt(side, from); index < side.lines.length; index++) {
      const line = side.lines[index]!;
      if (line.from >= to) break;
      if (line.change.type === "normal") continue;
      const start = Math.max(0, from - line.from);
      const end = Math.min(line.change.content.length, to - line.from);
      if (start < end) (ranges[line.change.lineNumber] ??= []).push({ from: start, to: end });
    }
  }
  for (const { change } of side.lines) {
    if (change.type === "normal" || !ranges[change.lineNumber]) continue;
    const partial = graphemeRanges(change.content, ranges[change.lineNumber]!);
    if (partial.length) ranges[change.lineNumber] = partial;
    else delete ranges[change.lineNumber];
  }
  return ranges;
}

export function inlineDiff(hunk: HunkData): InlineHunk {
  const old = sideLines(hunk, "old");
  const next = sideLines(hunk, "new");
  const changes = presentableDiff(old.text, next.text, { timeout: 1000 });
  const anchors: [number, number][] = [];
  let a = 0;
  let b = 0;
  for (const change of [
    ...changes,
    {
      fromA: old.text.length,
      fromB: next.text.length,
      toA: old.text.length,
      toB: next.text.length,
    },
  ]) {
    // Only unchanged text supplies a line correspondence; indentation alone does not.
    while (a < change.fromA) {
      const oldIndex = lineAt(old, a);
      const newIndex = lineAt(next, b);
      const oldLine = old.lines[oldIndex]!;
      const newLine = next.lines[newIndex]!;
      const length = Math.min(
        change.fromA - a,
        oldLine.from + oldLine.change.content.length - a,
        newLine.from + newLine.change.content.length - b,
      );
      if (length && /\S/u.test(old.text.slice(a, a + length))) anchors.push([oldIndex, newIndex]);
      a += length;
      b += length;
      if (a < change.fromA) {
        a++;
        b++;
      }
    }
    a = change.toA;
    b = change.toB;
  }

  const rows: InlineHunk["rows"] = [];
  let oldIndex = 0;
  let newIndex = 0;
  const zip = (oldEnd: number, newEnd: number) => {
    while (oldIndex < oldEnd || newIndex < newEnd)
      rows.push([
        oldIndex < oldEnd ? old.lines[oldIndex++]!.index : null,
        newIndex < newEnd ? next.lines[newIndex++]!.index : null,
      ]);
  };
  // Git's context rows delimit replacement blocks, including repeated/empty lines.
  for (const context of [...hunk.changes.filter((change) => change.type === "normal"), null]) {
    const oldEnd = context
      ? old.lines.findIndex(({ change }) => change === context)
      : old.lines.length;
    const newEnd = context
      ? next.lines.findIndex(({ change }) => change === context)
      : next.lines.length;
    for (const [oldAnchor, newAnchor] of anchors) {
      if (
        oldAnchor < oldIndex ||
        newAnchor < newIndex ||
        oldAnchor >= oldEnd ||
        newAnchor >= newEnd
      )
        continue;
      zip(oldAnchor, newAnchor);
      zip(oldAnchor + 1, newAnchor + 1);
    }
    zip(oldEnd, newEnd);
    if (context) zip(oldEnd + 1, newEnd + 1);
  }
  return {
    rows,
    old: lineRanges(
      old,
      changes.map(({ fromA, toA }) => ({ from: fromA, to: toA })),
    ),
    new: lineRanges(
      next,
      changes.map(({ fromB, toB }) => ({ from: fromB, to: toB })),
    ),
  };
}
