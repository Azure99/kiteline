import { expect, test } from "vitest";
import {
  closePage,
  diffPageId,
  filePage,
  openPage,
  type FilePage,
  type WorkPage,
  type WorkPagesState,
} from "../src/workspace/pages";

const file = (path: string): FilePage => ({ kind: "file", id: `file:${path}`, path });
const diff: WorkPage = {
  kind: "diff",
  id: "diff",
  repoId: "repo",
  repoPath: ".",
  target: { path: "a.txt", side: "worktree" },
};

test("opening files and comparison pages retains every page", () => {
  let pages: WorkPagesState = { items: [] };
  pages = openPage(pages, file("a.txt"));
  pages = openPage(pages, file("b.txt"));
  pages = openPage(pages, diff);
  expect(pages.items.map((page) => page.id)).toEqual(["file:a.txt", "file:b.txt", "diff"]);
  expect(pages.active).toBe("diff");
});

test("returning to an existing page activates it without duplicating or replacing pages", () => {
  let pages = openPage({ items: [] }, file("a.txt"));
  pages = openPage(pages, diff);
  pages = openPage(pages, file("a.txt"));
  expect(pages.items.map((page) => page.id)).toEqual(["file:a.txt", "diff"]);
  expect(pages.active).toBe("file:a.txt");
});

test("reopening a comparison retains its scroll unless a new position is supplied", () => {
  let pages = openPage({ items: [] }, { ...diff, scroll: { top: 371, left: 24 } });
  pages = openPage(pages, { ...diff });
  expect(pages.items).toEqual([{ ...diff, scroll: { top: 371, left: 24 } }]);

  pages = openPage(pages, { ...diff, scroll: { top: 100, left: 0 } });
  expect(pages.items).toEqual([{ ...diff, scroll: { top: 100, left: 0 } }]);
});

test("reopening a comparison retains the selected patch line for continued reading", () => {
  const lineSelection = { patch: "patch snapshot", line: 216 };
  let pages = openPage({ items: [] }, { ...diff, lineSelection });
  pages = openPage(pages, { ...diff });
  expect(pages.items).toMatchObject([{ ...diff, lineSelection }]);
});

test("closing chooses the adjacent mixed page and background close preserves selection", () => {
  const original: WorkPagesState = { items: [file("a.txt"), diff, file("b.txt")], active: "diff" };
  expect(closePage(original, "file:a.txt").active).toBe("diff");
  const next = closePage(original, "diff");
  expect(next.active).toBe("file:b.txt");
  const last = closePage(next, "file:b.txt");
  expect(last.active).toBe("file:a.txt");
  expect(closePage(last, "file:a.txt").active).toBeUndefined();
});

test("loading and renaming a draft preserve its tab identity", () => {
  let pages = openPage({ items: [] }, file("a.txt"));
  pages = openPage(pages, { kind: "file", id: "draft:d", path: "a.txt", draftId: "d" });
  pages = openPage(pages, { kind: "file", id: "draft:d", path: "renamed.txt", draftId: "d" });
  expect(pages.items).toEqual([
    { kind: "file", id: "file:a.txt", path: "renamed.txt", draftId: "d" },
  ]);
  expect(pages.active).toBe("file:a.txt");
});

test("a closed draft URL cannot replace a later draft's retained path page", () => {
  const first = filePage("a.txt");
  let pages = openPage({ items: [] }, first);
  pages = openPage(pages, filePage("a.txt", "closed"));
  expect(pages.active).toBe(first.id);
  pages = closePage(pages, pages.active!);
  const second = filePage("a.txt");
  pages = openPage(pages, second);
  pages = openPage(pages, filePage("a.txt", "later"));
  const later = pages.items[0]!;
  expect(later).toMatchObject({ id: second.id, draftId: "later" });

  const stale = filePage("a.txt", "closed");
  pages = openPage(pages, stale);
  expect(pages.items).toEqual([later, stale]);
  expect(pages.active).toBe(stale.id);
  pages = closePage(pages, stale.id);
  expect(pages.items).toEqual([later]);
  expect(pages.active).toBe(later.id);
});

test("diff tabs distinguish repositories, paths, comparison sides and merge parents", () => {
  const ids = [
    diffPageId("one", { path: "a", side: "worktree" }),
    diffPageId("two", { path: "a", side: "worktree" }),
    diffPageId("one", { path: "b", side: "worktree" }),
    diffPageId("one", { path: "a", side: "staged" }),
    diffPageId("one", { path: "a", side: "commit", commitOid: "c", parentOid: "p1" }),
    diffPageId("one", { path: "a", side: "commit", commitOid: "c", parentOid: "p2" }),
    diffPageId("one", { path: "a", side: "commit", commitOid: "d", parentOid: "p1" }),
  ];
  expect(new Set(ids).size).toBe(ids.length);
});

test("reopening the former path of a retargeted draft opens a separate page", () => {
  const opened = filePage("a.txt");
  let pages = openPage({ items: [] }, opened);
  pages = openPage(pages, filePage("a.txt", "d"));
  // Save as, rename and move retarget the bound draft; the page follows its path.
  pages = { ...pages, items: pages.items.map((page) => ({ ...page, path: "b.txt" })) };
  pages = openPage(pages, filePage("a.txt"));
  expect(pages.items).toMatchObject([
    { id: opened.id, path: "b.txt", draftId: "d" },
    { path: "a.txt", draftId: undefined },
  ]);
  expect(pages.active).not.toBe(opened.id);
  pages = openPage(pages, filePage("b.txt", "d"));
  expect(pages.items).toHaveLength(2);
  expect(pages.active).toBe(opened.id);
});

test("repeated opening by path reuses the page without a stable path identity", () => {
  let pages = openPage({ items: [] }, filePage("a.txt"));
  const id = pages.active;
  pages = openPage(pages, filePage("a.txt"));
  pages = openPage(pages, filePage("a.txt", "d"));
  pages = openPage(pages, filePage("a.txt", "d"));
  expect(pages.items).toEqual([{ kind: "file", id, path: "a.txt", draftId: "d" }]);
});
