import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { Repo } from "@kiteline/shared/protocol";
import { useDrafts, type DraftStore } from "../files/drafts";
import { requestCloseDraft } from "../files/close-draft";
import { showDraft } from "../files/navigation";
import {
  currentPath,
  navigateWorkspace,
  updateWorkspaceQuery,
  useRoute,
  type NavigationOptions,
} from "../lib/navigation";
import type { DiffTarget } from "../git/diff-view";
import {
  closePage,
  diffPageId,
  filePage,
  openPage,
  type WorkPage,
  type WorkPagesState,
} from "./pages";
import { workspaceKey, type WorkspaceRecord } from "./memory";

export function useWorkPages(
  store: DraftStore,
  memory: WorkspaceRecord,
  deviceId: string,
  workspaceId: string,
) {
  const target = { deviceId, workspaceId };
  const key = workspaceKey(target);
  const route = useRoute();
  const drafts = useDrafts(store);
  const [state, setState] = useState<WorkPagesState>(() => memory.pages ?? { items: [] });
  const path = currentPath();
  const previousPath = useRef<string>(undefined);
  const draftFor = (page: WorkPage) =>
    page.kind === "file"
      ? drafts.find(
          (draft) =>
            draft.deviceId === deviceId &&
            draft.workspaceId === workspaceId &&
            (page.draftId ? draft.id === page.draftId : !!page.path && draft.path === page.path),
        )
      : undefined;
  function navigateTo(page?: WorkPage, options: NavigationOptions = {}) {
    if (page?.kind === "file") {
      const draft = draftFor(page);
      if (draft) showDraft(draft, options);
      else
        navigateWorkspace(
          target,
          "files",
          { file: page.path, draft: undefined, search: undefined },
          options,
        );
    } else if (page) {
      navigateWorkspace(target, "git", { repo: page.repoId, search: undefined }, options);
    } else updateWorkspaceQuery(target, { file: undefined, draft: undefined }, { replace: true });
  }
  function reconcileDraftIdentities() {
    let next = state;
    for (const page of state.items) {
      if (page.kind !== "file") continue;
      const draft = draftFor(page);
      if (page.draftId && !draft) next = closePage(next, page.id);
      else if (draft) {
        if (page.draftId !== draft.id || page.path !== draft.path)
          next = {
            ...next,
            items: next.items.map((item) =>
              item.id === page.id ? { ...page, draftId: draft.id, path: draft.path } : item,
            ),
          };
      }
    }
    return next;
  }
  const consumeWorkspacePages = useEffectEvent(() => {
    let next = reconcileDraftIdentities();
    let selectedByRoute = false;
    if (path !== previousPath.current) {
      previousPath.current = path;
      const historical = history.state?.workPage;
      if (route.tool === "files" && (route.query.file || route.query.draft)) {
        selectedByRoute = true;
        const draft = store.find({ ...target, path: route.query.file ?? "" }, route.query.draft);
        next = openPage(
          next,
          filePage(draft?.path ?? route.query.file ?? "", draft?.id ?? route.query.draft),
        );
      } else if (
        historical?.workspace === key &&
        next.items.some((page) => page.id === historical.id)
      ) {
        selectedByRoute = true;
        next = { ...next, active: historical.id };
      }
    }
    if (!selectedByRoute && next.active !== state.active) {
      navigateTo(
        next.items.find((page) => page.id === next.active),
        { replace: true },
      );
    }
    if (next !== state) setState(next);
    memory.pages = next;
    // History identifies only tabs still open in this page, not a persisted diff URL.
    history.replaceState({ ...history.state, workPage: { workspace: key, id: next.active } }, "");
  });
  useLayoutEffect(() => {
    consumeWorkspacePages();
  }, [state, drafts, path]);
  function select(page: WorkPage) {
    setState({ ...state, active: page.id });
    navigateTo(page);
  }
  function close(page: WorkPage) {
    const draft = draftFor(page);
    if (draft) {
      requestCloseDraft(store, draft);
      return;
    }
    const next = closePage(state, page.id);
    setState(next);
    if (state.active === page.id)
      navigateTo(
        next.items.find((item) => item.id === next.active),
        { replace: true },
      );
  }
  function openDiff(repo: Repo, diff: DiffTarget) {
    setState(
      openPage(state, {
        kind: "diff",
        id: diffPageId(repo.id, diff),
        repoId: repo.id,
        repoPath: repo.path,
        target: diff,
      }),
    );
    navigateWorkspace(target, "git", { repo: repo.id, search: undefined });
  }
  function resolvePath(pageId: string, from: string, to: string) {
    setState((old) => ({
      ...old,
      items: old.items.map((item) =>
        item.kind === "file" && item.id === pageId && item.path === from
          ? { ...item, path: to }
          : item,
      ),
    }));
  }
  return {
    ...state,
    activePage: state.items.find((item) => item.id === state.active),
    draftFor,
    select,
    close,
    openDiff,
    resolvePath,
  };
}
