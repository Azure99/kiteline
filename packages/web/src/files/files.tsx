import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { currentRoute, isWorkspaceRoute, updateWorkspaceQuery, useRoute } from "../lib/navigation";
import { useMobile } from "../lib/use-mobile";
import type { useTerminalFocus } from "../terminal/use-terminal-focus";
import type { FilePage } from "../workspace/pages";
import { DraftView } from "./draft-view";
import { useDrafts, type Draft, type DraftStore } from "./drafts";
import { FileBrowser } from "./file-browser";
import { FileContent } from "./file-content";
import { showFile } from "./navigation";
import type { FileAction } from "./operation-dialog";
import { parentPath } from "./paths";
import type { TextLocation } from "./text-editor";

export function Files({
  device,
  workspace,
  browsing,
  contentVisible,
  page,
  onOpenContent,
  onResolvePath,
  store,
  onUpload,
  onOperation,
  focusMode,
}: {
  focusMode?: ReturnType<typeof useTerminalFocus>;
  device: Device;
  workspace: Workspace;
  browsing: boolean;
  contentVisible: boolean;
  page?: FilePage;
  onOpenContent(): void;
  onResolvePath(pageId: string, from: string, to: string): void;
  store: DraftStore;
  onUpload(files: File[], folder: string): void;
  onOperation(action: FileAction, folder: string): void;
}) {
  const { t } = useTranslation();
  const mobile = useMobile();
  const route = useRoute();
  const drafts = useDrafts(store);
  const target = { deviceId: device.id, workspaceId: workspace.id };
  const draft = page && store.find({ ...target, path: page.path }, page.draftId);
  const enabled = device.status === "online";
  const [pending, setPending] = useState<{
    pageId?: string;
    path: string;
    position: TextLocation;
  }>();
  const queryLine =
    route.query.file === page?.path && route.query.draft === page?.draftId
      ? route.query.line
      : undefined;
  const routeLocation = useMemo(
    () => (page?.id && queryLine !== undefined ? { line: queryLine } : undefined),
    [page?.id, queryLine],
  );
  const position =
    routeLocation ??
    (pending?.pageId === page?.id && pending?.path === page?.path ? pending?.position : undefined);
  useEffect(() => {
    setPending((current) => {
      if (!current) return current;
      if (route.query.file !== current.path || route.query.line !== undefined) return undefined;
      if (current.pageId !== undefined) return current.pageId === page?.id ? current : undefined;
      if (page?.path === current.path && route.query.draft === page.draftId && contentVisible)
        return { ...current, pageId: page.id };
      return current;
    });
  }, [contentVisible, page, pending, route.query.file, route.query.draft, route.query.line]);
  useEffect(() => {
    if (!contentVisible || !page || !draft) return;
    const target = { deviceId: device.id, workspaceId: workspace.id };
    const current = currentRoute();
    if (
      current.tool === "files" &&
      isWorkspaceRoute(current, target) &&
      current.query.file === page.path &&
      !current.query.draft
    )
      updateWorkspaceQuery(target, { file: draft.path, draft: draft.id }, { replace: true });
  }, [contentVisible, page, draft, device.id, workspace.id]);
  function resolvePath(requested: string, actual: string, loadedDraft?: Draft) {
    if (!page || page.path !== requested) return;
    if (actual !== requested) {
      onResolvePath(page.id, requested, actual);
      setPending((current) =>
        current?.pageId === page.id && current.path === requested
          ? { ...current, path: actual }
          : current,
      );
    }
    const current = currentRoute();
    if (
      current.tool !== "files" ||
      !isWorkspaceRoute(current, target) ||
      current.query.file !== requested ||
      current.query.draft !== page.draftId
    )
      return;
    updateWorkspaceQuery(
      target,
      {
        file: actual,
        draft: loadedDraft?.id,
        ...(actual !== requested ? { folder: parentPath(actual) } : {}),
      },
      { replace: true },
    );
  }
  return (
    <FileBrowser
      {...{ device, workspace, browsing, contentVisible, store, onUpload, onOperation }}
      currentFile={page?.path}
      onOpenContent={onOpenContent}
      onOpenFile={(path, position, keepSearch) => {
        if (position) setPending({ path, position });
        onOpenContent();
        showFile({ ...target, path }, undefined, keepSearch);
      }}
      observeContent={async (signal) => {
        const draft = page && store.find({ ...target, path: page.path }, page.draftId);
        if (draft) await store.observe(draft, signal);
      }}
    >
      <section
        className="flex min-w-0 flex-1 flex-col max-desk:min-h-0 max-desk:overflow-y-auto"
        aria-label={t(($) => $.files.fileContent)}
      >
        {draft ? (
          <DraftView
            key={draft.id}
            {...{ store, draft }}
            focusMode={mobile ? focusMode : undefined}
            showTabs={false}
            editorVisible={contentVisible}
            htmlPreviewVisible={contentVisible && queryLine === undefined && !position}
            location={position}
            onLocationApplied={(applied) => {
              setPending((current) => (current?.position === applied ? undefined : current));
              if (applied !== routeLocation || !page) return;
              const current = currentRoute();
              if (
                current.tool === "files" &&
                isWorkspaceRoute(current, target) &&
                current.query.file === page.path &&
                current.query.line === queryLine
              )
                updateWorkspaceQuery(target, { line: undefined }, { replace: true });
            }}
            unavailable={!enabled ? t(($) => $.common.deviceOffline) : undefined}
          />
        ) : page?.path && !page.draftId ? (
          <FileContent
            key={`${page.id}:${page.path}`}
            onResolvePath={resolvePath}
            target={{
              ...target,
              path: page.path,
              deviceName: device.name,
              workspaceName: workspace.name,
            }}
            store={store}
            active={contentVisible && enabled}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {!drafts.some(
              (item) => item.deviceId === device.id && item.workspaceId === workspace.id,
            ) && t(($) => $.files.selectFiles)}
          </div>
        )}
      </section>
    </FileBrowser>
  );
}
