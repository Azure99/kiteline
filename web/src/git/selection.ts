import type { GitEntry, GitStatus, HeadIdentity } from "@kiteline/shared/protocol";

export type ChangeSide = "staged" | "worktree" | "conflict";
export interface ChangeSelection {
  side: ChangeSide;
  path: string;
  signature: string;
}
export function inSide(entry: GitEntry, side: ChangeSide) {
  if (side === "conflict") return entry.conflict;
  if (entry.conflict) return false;
  return side === "staged" ? ![".", "?"].includes(entry.indexStatus) : entry.worktreeStatus !== ".";
}
export function selectionOf(entry: GitEntry, side: ChangeSide): ChangeSelection {
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
    return entry && selectionOf(entry, item.side).signature === item.signature;
  });
}
