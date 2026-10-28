import {
  indexRenameSource,
  isStagedChange,
  type GitEntry,
  type GitStatus,
  type HeadIdentity,
} from "@kiteline/shared/protocol";

export type ChangeSide = "staged" | "worktree" | "conflict";
export interface ChangeSelection {
  side: ChangeSide;
  path: string;
  signature: string;
}
export function defaultIndexPaths(entry: GitEntry & { path: string }, side: ChangeSide) {
  const oldPath = side === "staged" ? indexRenameSource(entry) : undefined;
  return oldPath ? [entry.path, oldPath] : [entry.path];
}
export function withoutSelection(selected: ChangeSelection[], removed: ChangeSelection[]) {
  return selected.filter(
    (item) =>
      !removed.some(
        (other) =>
          item.path === other.path &&
          item.side === other.side &&
          item.signature === other.signature,
      ),
  );
}
export function inSide(entry: GitEntry, side: ChangeSide) {
  if (side === "conflict") return entry.conflict;
  return side === "staged"
    ? isStagedChange(entry)
    : !entry.conflict && entry.worktreeStatus !== ".";
}
export function selectionOf(entry: GitEntry & { path: string }, side: ChangeSide): ChangeSelection {
  const status = side === "staged" ? entry.indexStatus : entry.worktreeStatus;
  const types =
    side === "staged"
      ? [entry.types.head, entry.types.index]
      : side === "worktree"
        ? [entry.types.index, entry.types.worktree]
        : entry.types;
  return {
    path: entry.path,
    side,
    signature: JSON.stringify([
      status,
      types,
      side === "conflict" ? entry.indexStatus : null,
      /[RC]/.test(status) ? entry.oldPath : null,
      side === "worktree" ? entry.submodule?.commitChanged : undefined,
    ]),
  };
}
export function sameHeadContext(a: HeadIdentity, b: HeadIdentity) {
  return a.symbolicRef === b.symbolicRef && (a.symbolicRef !== null || a.oid === b.oid);
}
export function reconcileSelection(
  selected: ChangeSelection[],
  previous: GitStatus | undefined,
  next: GitStatus,
) {
  if (!previous || previous.offset !== next.offset || !sameHeadContext(previous.head, next.head))
    return [];
  return selected.filter((item) => {
    const entry = next.entries.find(
      (entry) => entry.path === item.path && inSide(entry, item.side),
    );
    return entry?.path !== undefined && selectionOf(entry, item.side).signature === item.signature;
  });
}
