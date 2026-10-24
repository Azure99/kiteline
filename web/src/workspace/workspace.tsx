import { useEffectEvent, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
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
import { WorkspaceView } from "../terminal/workspace-view";
import type { DraftStore } from "../files/drafts";
import type { FileAction } from "../files/operation-dialog";
import type { GitActions } from "../git/actions";
import { useRepos } from "../git/use-repos";
import type { GitBrowseState } from "../git/git";
import type { WorkPagesState } from "./pages";
import { useWorkPages } from "./use-work-pages";
import { WorkPages } from "./work-pages";
import { DiffPageView } from "./diff-page";

const Files = deferredView(async () => ({ default: (await import("../files/files")).Files }), {
  active: (props) => props.browsing || props.contentVisible,
});
const GitTool = deferredView(async () => ({ default: (await import("../git/git")).GitTool }), {
  active: (props) => props.visible,
});
type Mode = "work" | "both" | "terminal";
type Position = "bottom" | "right" | "top" | "left";
const positions: Position[] = ["bottom", "right", "top", "left"];
const positionIcons = { bottom: PanelBottom, right: PanelRight, top: PanelTop, left: PanelLeft };
type View = {
  mode: Mode;
  mobileMode: "work" | "terminal";
  tool: "files" | "git";
  position: Position;
  ratio: number;
  rightOpen: boolean;
};
export interface WorkspaceMemory {
  view: View;
  path: string;
}

export function Workspace({
  device,
  workspace,
  layouts,
  onLayout,
  onActivateTerminal,
  activationRequest,
  focusMode,
  onCliSetup,
  store,
  actions,
  onUpload,
  onOperation,
  views,
  savedPages,
  gitBrowsing,
  controlsHost,
  toolsHost,
  mobileTools,
  onMobileTools,
  navigationOpen,
}: Omit<ComponentProps<typeof WorkspaceView>, "visible" | "onSelectTerminal"> & {
  store: DraftStore;
  actions: GitActions;
  onUpload(files: File[], folder: string): void;
  onOperation(action: FileAction, folder: string): void;
  views: Map<string, WorkspaceMemory>;
  savedPages: Map<string, WorkPagesState>;
  gitBrowsing: Map<string, GitBrowseState>;
  controlsHost: HTMLDivElement | null;
  toolsHost: HTMLDivElement | null;
  mobileTools: boolean;
  navigationOpen: boolean;
  onMobileTools(open: boolean): void;
}) {
  const { t } = useTranslation();
  const route = useRoute();
  const mobile = useMobile();
  const target = { deviceId: device.id, workspaceId: workspace.id };
  const key = `${device.id}:${workspace.id}`;
  const path = currentPath();
  const [view, setView] = useState<View>(() => {
    const saved = views.get(key);
    if (saved?.path === path) return saved.view;
    return {
      mode: route.tool === "terminal" ? "terminal" : "work",
      mobileMode: route.tool === "terminal" ? "terminal" : "work",
      tool: route.tool === "git" ? "git" : "files",
      position: saved?.view.position ?? "bottom",
      ratio: saved?.view.ratio ?? 60,
      rightOpen: true,
    };
  });
  useLayoutEffect(() => {
    views.set(key, { view, path });
  }, [views, key, view, path]);
  const [fileHeader, setFileHeader] = useState<HTMLDivElement | null>(null);
  const [fileSidebar, setFileSidebar] = useState<HTMLDivElement | null>(null);
  const rightToggle = useRef<HTMLButtonElement>(null);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const pages = useWorkPages(store, savedPages, device.id, workspace.id);
  const previous = useRef<typeof route>(undefined);
  const previousActivation = useRef(activationRequest);
  function showContent() {
    onMobileTools(false);
    setView((old) => ({
      ...old,
      mobileMode: "work",
      mode: !mobile && old.mode === "terminal" ? "both" : old.mode,
    }));
  }
  const followRoute = useEffectEvent(() => {
    const before = previous.current;
    previous.current = route;
    if (
      (route.query.search !== before?.query.search && route.query.search) ||
      (route.query.reveal !== before?.query.reveal && route.query.reveal)
    ) {
      setView((old) => ({ ...old, tool: "files", rightOpen: true }));
      if (mobile) onMobileTools(true);
    } else if (
      route.tool === "files" &&
      (route.tool !== before?.tool ||
        route.query.file !== before?.query.file ||
        route.query.draft !== before?.query.draft)
    ) {
      if (route.query.file || route.query.draft) showContent();
    } else if (
      activationRequest !== previousActivation.current ||
      (route.tool === "terminal" &&
        (route.tool !== before?.tool || route.query.session !== before?.query.session))
    ) {
      onMobileTools(false);
      setView((old) => ({
        ...old,
        mobileMode: "terminal",
        mode: !mobile && old.mode === "work" ? "both" : old.mode,
      }));
    }
    previousActivation.current = activationRequest;
  });
  useLayoutEffect(() => {
    followRoute();
  }, [route, activationRequest]);
  const previousMobile = useRef(mobile);
  const handoffContent = useEffectEvent(() => {
    if (previousMobile.current === mobile) return;
    previousMobile.current = mobile;
    if (!mobile && focusMode.active && view.mobileMode === "work") focusMode.exit();
    setView((old) => {
      if (mobile) {
        const mobileMode =
          focusMode.active || old.mode === "terminal"
            ? "terminal"
            : old.mode === "work"
              ? "work"
              : old.mobileMode;
        return { ...old, mobileMode };
      }
      return {
        ...old,
        mode: old.mode !== "both" && old.mode !== old.mobileMode ? "both" : old.mode,
      };
    });
  });
  useLayoutEffect(() => {
    handoffContent();
  }, [mobile]);
  const mode = focusMode.active && !mobile ? "terminal" : mobile ? view.mobileMode : view.mode;
  const terminalVisible = mode !== "work";
  const contentVisible = mode !== "terminal";
  const toolsVisible =
    !focusMode.active && !navigationOpen && (mobile ? mobileTools : view.rightOpen);
  const repositories = useRepos(
    device.id,
    workspace.id,
    device.status === "online" &&
      ((toolsVisible && view.tool === "git") ||
        (contentVisible && pages.activePage?.kind === "diff")),
  );
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute(
      "data-terminal-active",
      terminalVisible && !(mobile && (navigationOpen || mobileTools)),
    );
    return () => document.documentElement.removeAttribute("data-terminal-active");
  }, [terminalVisible, mobile, navigationOpen, mobileTools]);
  function chooseMode(next: Mode) {
    if (focusMode.active) focusMode.exit();
    setView((old) => ({
      ...old,
      ...(mobile ? { mobileMode: next as "work" | "terminal" } : { mode: next }),
    }));
    if (next === "work") {
      if (pages.activePage) pages.select(pages.activePage);
      else navigateWorkspace(target, "files");
    } else if (next === "terminal") navigateWorkspace(target, "terminal");
  }
  const vertical = view.position === "top" || view.position === "bottom";
  const terminalFirst = view.position === "top" || view.position === "left";
  const nextMode = mode === "work" ? "both" : mode === "both" ? "terminal" : "work";
  const ModeIcon = mode === "work" ? FilesIcon : mode === "both" ? PanelsTopLeft : Terminal;
  const nextPosition = positions[(positions.indexOf(view.position) + 1) % positions.length]!;
  const PositionIcon = positionIcons[view.position];
  function modeLabel(mode: Mode) {
    return t(($) =>
      mode === "work" ? $.shell.workPages : mode === "both" ? $.shell.cooperate : $.common.terminal,
    );
  }
  function positionLabel(position: Position) {
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
            view.mobileMode === "work"
              ? t(($) => $.shell.switchToTerminal)
              : t(($) => $.shell.switchToWorkPages)
          }
          onClick={() => chooseMode(view.mobileMode === "work" ? "terminal" : "work")}
        >
          {view.mobileMode === "work" ? <Terminal /> : <FilesIcon />}
        </IconButton>
      ) : (
        <>
          {mode === "both" && (
            <IconButton
              label={t(($) => $.shell.terminalPosition, {
                current: positionLabel(view.position),
                next: positionLabel(nextPosition),
              })}
              onClick={() => setView((old) => ({ ...old, position: nextPosition }))}
            >
              <PositionIcon />
            </IconButton>
          )}
          <IconButton
            label={t(($) => $.shell.workspaceMode, {
              current: modeLabel(mode),
              next: modeLabel(nextMode),
            })}
            onClick={() => chooseMode(nextMode)}
          >
            <ModeIcon />
          </IconButton>
        </>
      )}
      <IconButton
        ref={rightToggle}
        label={t(($) => (toolsVisible ? $.shell.collapseTools : $.shell.expandTools))}
        aria-expanded={toolsVisible}
        aria-controls="workspace-tools"
        onClick={() => {
          if (focusMode.active) focusMode.exit();
          if (mobile) onMobileTools(true);
          else setView((old) => ({ ...old, rightOpen: !toolsVisible }));
        }}
      >
        {toolsVisible ? <PanelRightClose /> : <PanelRightOpen />}
      </IconButton>
    </>
  );
  const workPanel = (
    <Panel
      key="work"
      id="work"
      defaultSize={`${view.ratio}%`}
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
          browsing={toolsVisible && view.tool === "files"}
          contentVisible={contentVisible && pages.activePage?.kind === "file"}
          onOpenContent={showContent}
          onResolvePath={pages.resolvePath}
          onUpload={onUpload}
          onOperation={onOperation}
        />
        {pages.activePage?.kind === "diff" && (
          <DiffPageView
            key={pages.activePage.id}
            page={pages.activePage}
            deviceId={device.id}
            workspaceId={workspace.id}
            actions={actions}
            repositories={repositories}
            view={diffView}
            onView={setDiffView}
            active={contentVisible && device.status === "online"}
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
      defaultSize={`${100 - view.ratio}%`}
      minSize="20%"
      className="terminal-panel flex min-h-0 min-w-0 flex-col"
    >
      <WorkspaceView
        {...{
          device,
          workspace,
          layouts,
          onLayout,
          onActivateTerminal,
          activationRequest,
          focusMode,
          onCliSetup,
        }}
        onSelectTerminal={() => setView((old) => ({ ...old, mobileMode: "terminal" }))}
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
          data-mode={mode}
          orientation={vertical ? "vertical" : "horizontal"}
          onLayoutChanged={(sizes, meta) => {
            if (meta.isUserInteraction) setView((old) => ({ ...old, ratio: sizes.work! }));
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
            id="workspace-tools"
            side="right"
            mobile={mobile}
            open={toolsVisible}
            onClose={() => onMobileTools(false)}
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
                  onClick={() => onMobileTools(false)}
                >
                  <ArrowLeft />
                </IconButton>
              )}
              {(["files", "git"] as const).map((tool) => (
                <button
                  key={tool}
                  role="tab"
                  aria-selected={view.tool === tool}
                  className={`flex min-h-9 items-center gap-2 rounded px-3 text-sm max-desk:min-h-11 ${view.tool === tool ? "bg-primary-soft text-primary" : "hover:bg-background"}`}
                  onClick={() => setView((old) => ({ ...old, tool }))}
                >
                  {tool === "files" ? <FilesIcon size={15} /> : <GitBranch size={15} />}
                  {t(($) => $.common[tool])}
                </button>
              ))}
            </div>
            <div
              ref={setFileHeader}
              className={view.tool === "files" ? "flex shrink-0 flex-col" : "hidden"}
            />
            <div
              ref={setFileSidebar}
              className={view.tool === "files" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            />
            <GitTool
              device={device}
              workspace={workspace}
              store={store}
              actions={actions}
              saved={gitBrowsing}
              repositories={repositories}
              selected={view.tool === "git"}
              visible={toolsVisible && view.tool === "git"}
              activeDiff={pages.activePage?.kind === "diff" ? pages.activePage : undefined}
              onDiff={(repo, diff) => {
                pages.openDiff(repo, diff);
                showContent();
              }}
            />
          </EdgePanel>,
          toolsHost,
        )}
    </>
  );
}
