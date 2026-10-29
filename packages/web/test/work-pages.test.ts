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
  let pages = openPage({ items: [] }, filePage("a.txt"));
  pages = openPage(pages, filePage("a.txt", "closed"));
  expect(pages.active).toBe("path:a.txt");
  pages = closePage(pages, pages.active!);
  pages = openPage(pages, filePage("a.txt"));
  pages = openPage(pages, filePage("a.txt", "later"));
  const later = pages.items[0]!;
  expect(later).toMatchObject({ id: "path:a.txt", draftId: "later" });

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
