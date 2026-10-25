import { useCallback, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Device, Workspace as WorkspaceInfo } from "@kiteline/shared/protocol";
import {
  ArrowLeft,
  PanelBottom,
  PanelTop,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Files as FilesIcon,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  Terminal,
} from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { IconButton } from "../components/icon-button";
import { ToolLayout } from "../components/tool-layout";
import { EdgePanel } from "../components/edge-panel";
import { deferredView } from "../components/deferred-view";
import { currentPath, navigateWorkspace, useRoute } from "../lib/navigation";
import { useMobile } from "../lib/use-mobile";
import { TerminalArea } from "../terminal/terminal-area";
import type { useTerminalFocus } from "../terminal/use-terminal-focus";
import type { ReceivedReport } from "../terminal/reports";
import type { CliAttachTarget } from "../cli/cli-dialog";
import type { DraftStore } from "../files/drafts";
import type { FileAction } from "../files/operation-dialog";
import type { GitActions } from "../git/actions";
import { useRepos } from "../git/use-repos";
import type { TerminalLayout } from "../terminal/groups";
import type {
  ContentMode,
  TerminalPosition,
  WorkspacePresentation,
  WorkspaceRecord,
} from "./memory";
import { useWorkPages } from "./use-work-pages";
import { WorkPages } from "./work-pages";
import { DiffPageView } from "./diff-page";

const Files = deferredView(async () => ({ default: (await import("../files/files")).Files }), {
  active: (props) => props.browsing || props.contentVisible,
});
const GitTool = deferredView(async () => ({ default: (await import("../git/git")).GitTool }), {
  active: (props) => props.visible,
});
const terminalPositions: TerminalPosition[] = ["bottom", "right", "top", "left"];
const terminalPositionIcons = {
  bottom: PanelBottom,
  right: PanelRight,
  top: PanelTop,
  left: PanelLeft,
};
export function Workspace({
  device,
  workspace,
  memory,
  onLayout,
  onActivateTerminal,
  activationRequest,
  focusMode,
  reports,
  onCliAttach,
  store,
  actions,
  onUpload,
  onOperation,
  controlsHost,
  toolsHost,
  navigationOpen,
}: {
  device: Device;
  workspace: WorkspaceInfo;
  onActivateTerminal(deviceId: string, workspaceId: string, sessionId: string): void;
  activationRequest: number;
  focusMode: ReturnType<typeof useTerminalFocus>;
  reports: readonly ReceivedReport[];
  onCliAttach(target: CliAttachTarget): void;
  store: DraftStore;
  actions: GitActions;
  onUpload(files: File[], folder: string): void;
  onOperation(action: FileAction, folder: string): void;
  memory: WorkspaceRecord;
  onLayout(memory: WorkspaceRecord, layout: TerminalLayout): void;
  controlsHost: HTMLDivElement | null;
  toolsHost: HTMLDivElement | null;
  navigationOpen: boolean;
}) {
  const { t } = useTranslation();
  const route = useRoute();
  const mobile = useMobile();
  const target = { deviceId: device.id, workspaceId: workspace.id };
  const path = currentPath();
  const [mobileTools, setMobileTools] = useState(
    () => !!(route.query.search || route.query.reveal),
  );
  const [presentation, setPresentation] = useState<WorkspacePresentation>(() => {
    const saved = memory.presentation;
    if (saved?.path === path) return saved.state;

    let initialContent: "work" | "terminal" = "work";
    if (route.tool === "terminal") initialContent = "terminal";
    const rightTool = route.tool === "git" ? "git" : "files";
    return {
      mode: initialContent,
      mobileMode: initialContent,
      rightTool,
      position: saved?.state.position ?? "bottom",
      ratio: saved?.state.ratio ?? 60,
      rightToolsOpen: true,
      rightToolsWidth: saved?.state.rightToolsWidth,
    };
  });
  useLayoutEffect(() => {
    memory.presentation = { state: presentation, path };
  }, [memory, presentation, path]);
  const saveLayout = useCallback(
    (layout: TerminalLayout) => onLayout(memory, layout),
    [memory, onLayout],
  );
  const [fileHeader, setFileHeader] = useState<HTMLDivElement | null>(null);
  const [fileSidebar, setFileSidebar] = useState<HTMLDivElement | null>(null);
  const rightToggle = useRef<HTMLButtonElement>(null);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const pages = useWorkPages(store, memory, device.id, workspace.id);

  function revealWorkPages() {
    setMobileTools(false);
    setPresentation((previous) => {
      let mode = previous.mode;
      if (!mobile && mode === "terminal") mode = "both";
      return { ...previous, mobileMode: "work", mode };
    });
  }

  const previousRoute = useRef<typeof route>(undefined);
  const previousActivationRequest = useRef(activationRequest);
  const previousMobile = useRef(mobile);
  const followRouteIntent = useEffectEvent(() => {
    const before = previousRoute.current;
    const searchRequested = route.query.search && route.query.search !== before?.query.search;
    const revealRequested = route.query.reveal && route.query.reveal !== before?.query.reveal;
    const fileSelectionChanged =
      route.tool === "files" &&
      (route.tool !== before?.tool ||
        route.query.file !== before?.query.file ||
        route.query.draft !== before?.query.draft);
    const terminalSelectionChanged =
      route.tool === "terminal" &&
      (route.tool !== before?.tool || route.query.session !== before?.query.session);
    const terminalActivationRequested = activationRequest !== previousActivationRequest.current;
    previousRoute.current = route;
    previousActivationRequest.current = activationRequest;

    if (route.query.search !== before?.query.search || route.query.reveal !== before?.query.reveal)
      setMobileTools(!!(route.query.search || route.query.reveal));

    if (searchRequested || revealRequested) {
      setPresentation((previous) => ({
        ...previous,
        rightTool: "files",
        rightToolsOpen: true,
      }));
      return false;
    }
    if (fileSelectionChanged) {
      // Opening a source file leaves the selected right tool unchanged.
      if (route.query.file || route.query.draft) {
        revealWorkPages();
        return true;
      }
      return false;
    }
    if (terminalSelectionChanged || terminalActivationRequested) {
      setMobileTools(false);
      setPresentation((previous) => {
        let mode = previous.mode;
        if (!mobile && mode === "work") mode = "both";
        return { ...previous, mobileMode: "terminal", mode };
      });
      return true;
    }
    return false;
  });
  const handoffAtBreakpoint = useEffectEvent(
    ({ contentSelected }: { contentSelected: boolean }) => {
      previousMobile.current = mobile;
      if (!mobile && focusMode.active && presentation.mobileMode === "work") focusMode.exit();

      setPresentation((previous) => {
        if (mobile) {
          if (contentSelected) return previous;
          let mobileMode = previous.mobileMode;
          if (focusMode.active || previous.mode === "terminal") mobileMode = "terminal";
          else if (previous.mode === "work") mobileMode = "work";
          return { ...previous, mobileMode };
        }
        let mode = previous.mode;
        if (mode !== "both" && mode !== previous.mobileMode) mode = "both";
        return { ...previous, mode };
      });
    },
  );
  useLayoutEffect(() => {
    let contentSelected = false;
    if (previousRoute.current !== route || previousActivationRequest.current !== activationRequest)
      contentSelected = followRouteIntent();
    // The functional handoff consumes any route update queued above.
    if (previousMobile.current !== mobile) handoffAtBreakpoint({ contentSelected });
  }, [route, activationRequest, mobile]);

  let visibleMode = presentation.mode;
  if (mobile) visibleMode = presentation.mobileMode;
  else if (focusMode.active) visibleMode = "terminal";
  const terminalVisible = visibleMode !== "work";
  const workPagesVisible = visibleMode !== "terminal";
  const rightToolsVisible =
    !focusMode.active && !navigationOpen && (mobile ? mobileTools : presentation.rightToolsOpen);
  const repositories = useRepos(
    device.id,
    workspace.id,
    device.status === "online" &&
      ((rightToolsVisible && presentation.rightTool === "git") ||
        (workPagesVisible && pages.activePage?.kind === "diff")),
  );
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute(
      "data-terminal-active",
      terminalVisible && !(mobile && (navigationOpen || mobileTools)),
    );
    return () => document.documentElement.removeAttribute("data-terminal-active");
  }, [terminalVisible, mobile, navigationOpen, mobileTools]);

  function selectContent(next: "work" | "terminal") {
    if (focusMode.active) focusMode.exit();
    setPresentation((previous) => {
      if (mobile) return { ...previous, mobileMode: next };
      return { ...previous, mode: next };
    });
    if (next === "work") {
      if (pages.activePage) pages.select(pages.activePage);
      else navigateWorkspace(target, "files");
    } else {
      navigateWorkspace(target, "terminal");
    }
  }
  function selectDesktopMode(next: ContentMode) {
    if (next !== "both") {
      selectContent(next);
      return;
    }
    if (focusMode.active) focusMode.exit();
    setPresentation((previous) => ({ ...previous, mode: "both" }));
  }
  const vertical = presentation.position === "top" || presentation.position === "bottom";
  const terminalFirst = presentation.position === "top" || presentation.position === "left";
  const nextMode = visibleMode === "work" ? "both" : visibleMode === "both" ? "terminal" : "work";
  const ModeIcon =
    visibleMode === "work" ? FilesIcon : visibleMode === "both" ? PanelsTopLeft : Terminal;
  const nextPosition =
    terminalPositions[
      (terminalPositions.indexOf(presentation.position) + 1) % terminalPositions.length
    ]!;
  const PositionIcon = terminalPositionIcons[presentation.position];
  function modeLabel(mode: ContentMode) {
    return t(($) =>
      mode === "work" ? $.shell.workPages : mode === "both" ? $.shell.cooperate : $.common.terminal,
    );
  }
  function positionLabel(position: TerminalPosition) {
    return t(($) =>
      position === "top"
        ? $.shell.terminalTop
        : position === "right"
          ? $.shell.terminalRight
          : position === "bottom"
            ? $.shell.terminalBottom
            : $.shell.terminalLeft,
    );
  }
  const controls = (
    <>
      {mobile ? (
        <IconButton
          label={
            presentation.mobileMode === "work"
              ? t(($) => $.shell.switchToTerminal)
              : t(($) => $.shell.switchToWorkPages)
          }
          onClick={() => selectContent(presentation.mobileMode === "work" ? "terminal" : "work")}
        >
          {presentation.mobileMode === "work" ? <Terminal /> : <FilesIcon />}
        </IconButton>
      ) : (
        <>
          {visibleMode === "both" && (
            <IconButton
              label={t(($) => $.shell.terminalPosition, {
                current: positionLabel(presentation.position),
                next: positionLabel(nextPosition),
              })}
              onClick={() =>
                setPresentation((previous) => ({ ...previous, position: nextPosition }))
              }
            >
              <PositionIcon />
            </IconButton>
          )}
          <IconButton
            label={t(($) => $.shell.workspaceMode, {
              current: modeLabel(visibleMode),
              next: modeLabel(nextMode),
            })}
            onClick={() => selectDesktopMode(nextMode)}
          >
            <ModeIcon />
          </IconButton>
        </>
      )}
      <IconButton
        ref={rightToggle}
        label={t(($) => (rightToolsVisible ? $.shell.collapseTools : $.shell.expandTools))}
        aria-expanded={rightToolsVisible}
        aria-controls="workspace-tools"
        onClick={() => {
          if (focusMode.active) focusMode.exit();
          if (mobile) setMobileTools(true);
          else setPresentation((previous) => ({ ...previous, rightToolsOpen: !rightToolsVisible }));
        }}
      >
        {rightToolsVisible ? <PanelRightClose /> : <PanelRightOpen />}
      </IconButton>
    </>
  );
  const workPanel = (
    <Panel
      key="work"
      id="work"
      defaultSize={`${presentation.ratio}%`}
      minSize="20%"
      className="work-page-panel flex min-h-0 min-w-0 flex-col"
    >
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label={t(($) => $.shell.workPages)}
      >
        <WorkPages pages={pages} hidden={focusMode.active} />
        <Files
          device={device}
          workspace={workspace}
          store={store}
          page={pages.activePage?.kind === "file" ? pages.activePage : undefined}
          focusMode={focusMode}
          browsing={rightToolsVisible && presentation.rightTool === "files"}
          contentVisible={workPagesVisible && pages.activePage?.kind === "file"}
          onOpenContent={revealWorkPages}
          onResolvePath={pages.resolvePath}
          onUpload={onUpload}
          onOperation={onOperation}
        />
        {pages.activePage?.kind === "diff" && (
          <DiffPageView
            key={pages.activePage.id}
            store={store}
            page={pages.activePage}
            deviceId={device.id}
            workspaceId={workspace.id}
            actions={actions}
            repositories={repositories}
            onDiff={(repo, diff) => {
              pages.openDiff(repo, diff);
              revealWorkPages();
            }}
            onChanges={() => {
              if (focusMode.active) focusMode.exit();
              setPresentation((previous) => ({
                ...previous,
                rightTool: "git",
                rightToolsOpen: true,
              }));
              if (mobile) setMobileTools(true);
              navigateWorkspace(target, "git", {
                repo: pages.activePage?.kind === "diff" ? pages.activePage.repoId : undefined,
              });
            }}
            view={diffView}
            onView={setDiffView}
            active={workPagesVisible && device.status === "online"}
          />
        )}
        {!pages.activePage && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
            {t(($) => $.shell.openWorkPage)}
          </div>
        )}
      </section>
    </Panel>
  );
  const terminalPanel = (
    <Panel
      key="terminal"
      id="terminal"
      defaultSize={`${100 - presentation.ratio}%`}
      minSize="20%"
      className="terminal-panel flex min-h-0 min-w-0 flex-col"
    >
      <TerminalArea
        {...{
          device,
          workspace,
          onActivateTerminal,
          activationRequest,
          focusMode,
          reports,
          onCliAttach,
        }}
        initialLayout={memory.terminalLayout}
        onLayout={saveLayout}
        onSelectTerminal={() => {
          setMobileTools(false);
          setPresentation((previous) => ({ ...previous, mobileMode: "terminal" }));
        }}
        visible={terminalVisible}
      />
    </Panel>
  );
  const divider = (
    <Separator
      key="divider"
      className="split-divider"
      aria-label={t(($) => $.shell.resizeWorkPages)}
    />
  );
  return (
    <>
      {controlsHost && createPortal(controls, controlsHost)}
      <ToolLayout header={fileHeader} sidebar={fileSidebar}>
        <Group
          className="workspace-panes min-h-0 min-w-0 flex-1"
          data-mode={visibleMode}
          orientation={vertical ? "vertical" : "horizontal"}
          onLayoutChanged={(sizes, meta) => {
            if (meta.isUserInteraction)
              setPresentation((previous) => ({ ...previous, ratio: sizes.work! }));
          }}
        >
          {terminalFirst
            ? [terminalPanel, divider, workPanel]
            : [workPanel, divider, terminalPanel]}
        </Group>
      </ToolLayout>
      {toolsHost &&
        createPortal(
          <EdgePanel
            desktopWidth={presentation.rightToolsWidth}
            onDesktopWidthChange={(rightToolsWidth) =>
              setPresentation((previous) => ({ ...previous, rightToolsWidth }))
            }
            id="workspace-tools"
            side="right"
            mobile={mobile}
            open={rightToolsVisible}
            onClose={() => setMobileTools(false)}
            returnFocus={rightToggle}
            label={t(($) => $.shell.workspaceTools)}
            className="workbench-tools flex min-h-0 shrink-0 flex-col border-l border-border bg-muted"
          >
            <div
              className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2 max-desk:min-h-11"
              role="tablist"
              aria-label={t(($) => $.shell.tools)}
            >
              {mobile && (
                <IconButton
                  label={t(($) => $.shell.returnToContent)}
                  onClick={() => setMobileTools(false)}
                >
                  <ArrowLeft />
                </IconButton>
              )}
              {(["files", "git"] as const).map((rightTool) => (
                <button
                  key={rightTool}
                  role="tab"
                  aria-selected={presentation.rightTool === rightTool}
                  className={`flex min-h-9 items-center gap-2 rounded px-3 text-sm max-desk:min-h-11 ${presentation.rightTool === rightTool ? "bg-primary-soft text-primary" : "hover:bg-background"}`}
                  onClick={() => setPresentation((previous) => ({ ...previous, rightTool }))}
                >
                  {rightTool === "files" ? <FilesIcon size={15} /> : <GitBranch size={15} />}
                  {t(($) => $.common[rightTool])}
                </button>
              ))}
            </div>
            <div
              ref={setFileHeader}
              className={presentation.rightTool === "files" ? "flex shrink-0 flex-col" : "hidden"}
            />
            <div
              ref={setFileSidebar}
              className={
                presentation.rightTool === "files" ? "flex min-h-0 flex-1 flex-col" : "hidden"
              }
            />
            <GitTool
              device={device}
              workspace={workspace}
              store={store}
              actions={actions}
              saved={memory.browsing}
              repositories={repositories}
              selected={presentation.rightTool === "git"}
              visible={rightToolsVisible && presentation.rightTool === "git"}
              activeDiff={pages.activePage?.kind === "diff" ? pages.activePage : undefined}
              onTerminal={() => {
                setMobileTools(false);
                selectContent("terminal");
              }}
              onDiff={(repo, diff) => {
                pages.openDiff(repo, diff);
                revealWorkPages();
              }}
            />
          </EdgePanel>,
          toolsHost,
        )}
    </>
  );
}
