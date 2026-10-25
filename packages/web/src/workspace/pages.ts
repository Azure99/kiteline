import type { DiffTarget } from "../git/diff-view";

export type FilePage = { kind: "file"; id: string; path: string; draftId?: string };
export type DiffPage = {
  kind: "diff";
  id: string;
  repoId: string;
  repoPath: string;
  target: DiffTarget;
};
export type WorkPage = FilePage | DiffPage;
export interface WorkPagesState {
  items: WorkPage[];
  active?: string;
}
export const diffPageId = (repoId: string, target: DiffTarget) =>
  JSON.stringify([
    repoId,
    target.side,
    target.path,
    target.side === "commit" ? target.commitOid : null,
    target.side === "commit" ? target.parentOid : null,
  ]);

export function openPage(state: WorkPagesState, page: WorkPage): WorkPagesState {
  const existing = state.items.find(
    (item) =>
      item.id === page.id ||
      (item.kind === "file" &&
        page.kind === "file" &&
        ((item.draftId && item.draftId === page.draftId) ||
          (item.path && item.path === page.path))),
  );
  if (existing) {
    return {
      ...state,
      items: state.items.map((item) => (item === existing ? { ...page, id: existing.id } : item)),
      active: existing.id,
    };
  }
  return { items: [...state.items, page], active: page.id };
}

export function closePage(state: WorkPagesState, id: string): WorkPagesState {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return state;
  const items = state.items.filter((item) => item.id !== id);
  return {
    items,
    active: state.active === id ? (items[index] ?? items[index - 1])?.id : state.active,
  };
}
