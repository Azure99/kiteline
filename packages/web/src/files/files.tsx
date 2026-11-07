import type { WorkspaceRecord } from "../workspace/memory";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import {
  currentRoute,
  isWorkspaceRoute,
  navigationIntent,
  updateWorkspaceQuery,
  useRoute,
} from "../lib/navigation";
import { useMobile } from "../lib/use-mobile";
import type { useTerminalFocus } from "../terminal/use-terminal-focus";
import type { FilePage } from "../workspace/pages";
import { DraftView, type DraftViewHandle } from "./draft-view";
import { useDrafts, type Draft, type DraftStore } from "./drafts";
import { FileBrowser } from "./file-browser";
import { FileContent } from "./file-content";
import {
  fileNavigationView,
  openFileLocation,
  showFile,
  useHistoricalFileLocation,
} from "./navigation";
import type { CodeNavigationRequest } from "./code-navigation";
import type { FileAction } from "./operation-dialog";
import { parentPath } from "./paths";
import type { TextLocation } from "./text-editor";
import type { FileSearchHandle } from "./file-search";

export function Files({
  memory,
  device,
  workspace,
  browsing,
  contentVisible,
  page,
  onOpenContent,
  onOpenSearch,
  onResolvePath,
  store,
  onUpload,
  onOperation,
  focusMode,
}: {
  focusMode?: ReturnType<typeof useTerminalFocus>;
  memory: WorkspaceRecord;
  device: Device;
  workspace: Workspace;
  browsing: boolean;
  contentVisible: boolean;
  page?: FilePage;
  onOpenContent(focusContent?: boolean): void;
  onOpenSearch(): void;
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
  const search = useRef<FileSearchHandle>(null);
  const draftView = useRef<DraftViewHandle>(null);
  const [navigationHost, setNavigationHost] = useState<HTMLDivElement | null>(null);
  const historical = useHistoricalFileLocation();
  function showNavigationResults() {
    flushSync(() => {
      onOpenSearch();
      updateWorkspaceQuery(target, { search: true }, { replace: true });
    });
  }
  function navigateName(request: CodeNavigationRequest) {
    setPending(undefined);
    showNavigationResults();
    search.current?.navigateName(request);
  }

  const [pending, setPending] = useState<{
    pageId?: string;
    path: string;
    position: TextLocation;
  }>();
  const [appliedHistoricalId, setAppliedHistoricalId] = useState<string>();
  const queryLine =
    route.query.file === page?.path && route.query.draft === page?.draftId
      ? route.query.line
      : undefined;
  const routeLocation = useMemo(
    () => (page?.id && queryLine !== undefined ? { line: queryLine } : undefined),
    [page?.id, queryLine],
  );
  const navigationSession = memory.fileNavigation?.session;
  const draftReady = !!draft?.state;
  // A location is resolved for this visit only; editing must not repeat its selection or focus.
  const historicalPosition = useMemo(() => {
    if (!historical || !draftReady || historical.sessionId !== navigationSession?.id) return;
    if (historical.kind === "origin") return navigationSession.tracker.originLocation();
    if (historical.kind === "document" && historical.entryKey)
      return navigationSession.tracker.entryLocation(
        historical.entryKey,
        historical.restoreReading,
      );
  }, [historical, navigationSession, draftReady]);
  const historicalLocation =
    page?.id &&
    historical?.deviceId === target.deviceId &&
    historical.workspaceId === target.workspaceId &&
    historical.path === page.path &&
    (!historical.draftId || historical.draftId === page.draftId) &&
    historical.requestId !== appliedHistoricalId
      ? historicalPosition
      : undefined;
  const position =
    routeLocation ??
    historicalLocation ??
    (pending?.pageId === page?.id && pending?.path === page?.path ? pending?.position : undefined);
  useEffect(() => {
    const opened = (event: PopStateEvent) => {
      if (navigationIntent(event) !== "view") setPending(undefined);
    };
    window.addEventListener("popstate", opened);
    return () => window.removeEventListener("popstate", opened);
  }, []);
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
      memory={memory}
      {...{ device, workspace, browsing, contentVisible, store, onUpload, onOperation }}
      currentFile={page?.path}
      onOpenContent={onOpenContent}
      searchActionRef={search}
      navigationHost={navigationHost}
      onShowNavigationResults={showNavigationResults}
      onCloseNavigation={() => {
        if (!mobile) draftView.current?.focus();
      }}
      onOpenFile={(request) => {
        onOpenContent(request.focusContent);
        if (request.kind === "lookup") {
          const destinationDraft = store.find({ ...target, path: request.path }, request.draftId);
          openFileLocation(
            {
              ...target,
              path: request.path,
              draftId: destinationDraft?.id ?? request.draftId,
              entryKey: request.lookup.entryKey,
            },
            request.lookup.sessionId,
          );
        } else {
          // The open notification consumes the old request before installing this position.
          showFile({ ...target, path: request.path }, undefined, request.keepSearch);
          setPending(
            request.position ? { path: request.path, position: request.position } : undefined,
          );
        }
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
            ref={draftView}
            key={draft.id}
            {...{ store, draft }}
            focusMode={mobile ? focusMode : undefined}
            showTabs={false}
            editorVisible={contentVisible}
            htmlPreviewVisible={contentVisible && queryLine === undefined && !position}
            location={position}
            onReadingLocation={
              historical?.kind === "document" &&
              historical.sessionId === navigationSession?.id &&
              historical.path === draft.path &&
              (!historical.draftId || historical.draftId === draft.id) &&
              historical.entryKey
                ? (reading) => {
                    const session = memory.fileNavigation?.session;
                    if (session?.id === historical.sessionId)
                      session.tracker.captureReading(historical.entryKey!, reading);
                  }
                : undefined
            }
            onNavigateName={navigateName}
            onOpenContainingDirectory={() =>
              updateWorkspaceQuery(
                target,
                {
                  folder: parentPath(draft.path),
                  reveal: draft.path,
                  search: undefined,
                  line: undefined,
                },
                fileNavigationView(memory),
              )
            }
            onLocationFinished={(applied, focusEditor) => {
              setPending((current) => (current?.position === applied ? undefined : current));
              if (applied === historicalLocation) setAppliedHistoricalId(historical!.requestId);
              if (!mobile && applied === historicalLocation) focusEditor?.();
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
        <div ref={setNavigationHost} className="contents" />
      </section>
    </FileBrowser>
  );
}
