import { expect, test } from "vitest";
import type { GitEntry, GitStatus } from "@kiteline/shared/protocol";
import { reconcileSelection, selectionOf } from "../src/git/selection";

const entry: GitEntry = {
  path: "new",
  oldPath: "old",
  types: { head: "file", index: "file", worktree: "file" },
  indexStatus: "R",
  worktreeStatus: "M",
  conflict: false,
};
const initial: GitStatus = {
  head: { symbolicRef: "refs/heads/main", oid: "a" },
  entries: [entry],
  offset: 0,
  totalCount: 1,
  listToken: "list",
  stagedCount: 1,
  hasConflicts: false,
  indexToken: "index",
  truncated: false,
};
test("same-branch commits preserve a remaining worktree selection but remove staged rename selection", () => {
  const worktree = selectionOf(entry, "worktree"),
    staged = selectionOf(entry, "staged");
  const after: GitStatus = {
    ...initial,
    head: { ...initial.head, oid: "b" },
    entries: [{ ...entry, oldPath: undefined, indexStatus: "." }],
    stagedCount: 0,
  };
  expect(reconcileSelection([worktree, staged], initial, after)).toEqual([worktree]);
  expect(
    reconcileSelection([worktree], initial, {
      ...after,
      head: { symbolicRef: "refs/heads/other", oid: "a" },
    }),
  ).toEqual([]);
  expect(reconcileSelection([worktree], initial, { ...after, offset: 500 })).toEqual([]);
});
test("an unchanged list token does not preserve selection when an untracked file becomes a link", () => {
  const item: GitEntry = {
    path: "item",
    types: { worktree: "file" },
    indexStatus: "?",
    worktreeStatus: "?",
    conflict: false,
  };
  const first = { ...initial, entries: [item] };
  expect(
    reconcileSelection([selectionOf(item, "worktree")], first, {
      ...first,
      entries: [{ ...item, types: { worktree: "symlink" } }],
    }),
  ).toEqual([]);
});
test("reading or changing files inside a submodule does not clear its staged pointer selection", () => {
  const item: GitEntry = {
    path: "module",
    types: { head: "gitlink", index: "gitlink", worktree: "gitlink" },
    indexStatus: "M",
    worktreeStatus: ".",
    conflict: false,
    submodule: { commitChanged: false, trackedDirty: false, untrackedDirty: false },
  };
  const first = { ...initial, entries: [item] };
  const selected = selectionOf(item, "staged");
  const changed = {
    ...first,
    entries: [
      { ...item, worktreeStatus: "M", submodule: { ...item.submodule!, trackedDirty: true } },
    ],
  };
  expect(reconcileSelection([selected], first, changed)).toEqual([selected]);
});
