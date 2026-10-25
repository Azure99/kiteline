import { newId } from "./lib/id";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EdgePanel } from "./components/edge-panel";
import { trackViewport } from "./lib/viewport";
import { useMobile } from "./lib/use-mobile";
import { AppearanceOptions } from "./components/appearance-menu";
import { LanguageOptions } from "./components/language-menu";
import {
  LogOut,
  Terminal,
  X,
  Upload,
  PanelLeftClose,
  PanelLeftOpen,
  Files as FilesIcon,
  CalendarClock,
  ArrowLeft,
  ChevronRight,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import type { Device, Workspace as WorkspaceInfo } from "@kiteline/shared/protocol";
import type { LoginSession } from "./auth";
import { apiError, errorMessage, post } from "./lib/api";
import { emit } from "./lib/events";
import { ErrorDetails } from "./components/error-notice";
import {
  currentPath,
  devicePath,
  navigate,
  parseRoute,
  useRoute,
  workspacePath,
  tasksPath,
  workspaceDestination,
} from "./lib/navigation";
import { useBrowserControlConnection } from "./devices/use-browser-control-connection";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./components/ui/menu";
import { IconButton } from "./components/icon-button";
import { BindingDialog } from "./devices/binding-dialog";
import { DirectoryDialog } from "./devices/directory-dialog";
import {
  DeviceActionDialog,
  type DeviceAction,
  type DeviceActions,
} from "./devices/device-actions";

import { DeviceNavigation } from "./devices/device-navigation";
import { Home, DeviceDetail } from "./devices/device-views";
import { useRecentWorkspaces, type RecentWorkspace } from "./devices/recent-workspaces";
import { Workspace } from "./workspace/workspace";
import { WorkspaceMemories, workspaceKey } from "./workspace/memory";
import { reportKey, type ReceivedReport } from "./terminal/reports";
import { GitActions } from "./git/actions";
import { DraftStore, isDirty } from "./files/drafts";
import { DraftView } from "./files/draft-view";
import { OpenFiles } from "./files/open-files";
import { UploadDialog } from "./files/upload-dialog";
import { FileOperationDialog, type FileAction } from "./files/operation-dialog";
import { PortDialog } from "./devices/port-dialog";
import { ReleaseNotice } from "./components/release-notice";
import { AgentReleaseNotice } from "./devices/agent-release-notice";
import { CliDialog, type CliAttachTarget } from "./cli/cli-dialog";
import { useTerminalFocus } from "./terminal/use-terminal-focus";
import { deferredView, ViewBoundary } from "./components/deferred-view";

const TasksPage = deferredView(async () => ({
  default: (await import("./tasks/tasks")).TasksPage,
}));

export function Workbench({
  session,
  setSession,
  authentication,
}: {
  session?: LoginSession;
  setSession(session?: LoginSession): void;
  authentication: ReactNode;
}) {
  const { t } = useTranslation();
  const route = useRoute();
  const mobile = useMobile();
  const authenticated = !!session;

  // These owners survive reauthentication; successful sign-out clears their contents.
  const [memories] = useState(() => new WorkspaceMemories());
  const [drafts] = useState(() => new DraftStore());
  const [gitActions] = useState(() => new GitActions());
  const [error, setError] = useState<WorkbenchError>();
  useEffect(
    function watchDraftFailuresAndPageExit() {
      const unload = (event: BeforeUnloadEvent) => {
        if (drafts.snapshot().some(isDirty)) {
          event.preventDefault();
          event.returnValue = "";
        }
      };
      const failed = (event: WindowEventMap["kiteline:event"]) => {
        const message = event.detail;
        if (message.type === "channel.failed") {
          drafts.fileFailed(message.channelId, message.error);
          if (message.purpose === "download" && message.error.code !== "cancelled")
            setError({
              cause: apiError(message.error),
              downloadPath: message.path,
            });
        }
      };
      window.addEventListener("beforeunload", unload);
      window.addEventListener("kiteline:event", failed);
      return () => {
        window.removeEventListener("beforeunload", unload);
        window.removeEventListener("kiteline:event", failed);
      };
    },
    [drafts],
  );
  useEffect(trackViewport, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState<number>();
  const expireSession = useCallback(() => {
    setSession(undefined);
    drafts.setClosing();
  }, [setSession, drafts]);
  async function signOut() {
    if (drafts.snapshot().some(isDirty) && !window.confirm(t(($) => $.shell.discardLogout))) return;
    try {
      await post("/api/logout");
      memories.clear();
      drafts.clear();
      gitActions.clear();
      setSession(undefined);
    } catch (error) {
      setError({ cause: error });
    }
  }
  useEffect(
    function watchSessionExpiration() {
      window.addEventListener("kiteline:unauthenticated", expireSession);
      return () => window.removeEventListener("kiteline:unauthenticated", expireSession);
    },
    [expireSession],
  );

  const control = useBrowserControlConnection(
    authenticated,
    route.deviceId,
    route.workspaceId,
    setSession,
  );
  const { devices, loaded: devicesLoaded, error: connectionError } = control;
  const recents = useRecentWorkspaces(route, devices, devicesLoaded, authenticated);
  const device = devices.find((d) => d.id === route.deviceId);
  const workspace = device?.snapshot?.workspaces.find((w) => w.id === route.workspaceId);
  let unavailable: string | undefined;
  if (route.deviceId && !device) {
    if (devicesLoaded) unavailable = t(($) => $.shell.deviceMissing);
    else if (connectionError) unavailable = t(($) => $.common.disconnected);
    else unavailable = t(($) => $.shell.connectingDevice);
  } else if (route.workspaceId && device && !workspace) {
    if (device.snapshot) unavailable = t(($) => $.shell.workspaceMissing);
    else if (device.status === "online") unavailable = t(($) => $.common.loading);
    else unavailable = t(($) => $.common.deviceOffline);
  }
  let contextTitle: string = t(($) => $.shell.home);
  if (!route.valid) contextTitle = t(($) => $.shell.pageMissing);
  else if (route.tasks)
    contextTitle = `${t(($) => $.schedules.title)}${device ? ` · ${device.name}` : ""}`;
  else if (route.deviceId) {
    if (unavailable) contextTitle = unavailable;
    else if (device) contextTitle = device.name;
  }
  const title =
    session && route.valid && device && workspace && route.tool
      ? `${workspace.name} · ${t(($) => $.common[route.tool!])} · ${device.name} · Kiteline`
      : session
        ? `${contextTitle} · Kiteline`
        : "Kiteline";
  useEffect(() => {
    document.title = title;
  }, [title]);
  const terminalFocus = useTerminalFocus(
    session &&
      route.valid &&
      (!mobile || route.tool === "terminal" || (route.tool === "files" && route.query.draft)) &&
      device &&
      workspace
      ? `${workspaceKey({ deviceId: device.id, workspaceId: workspace.id })}:${route.tool}`
      : undefined,
    session && route.valid && device && workspace
      ? workspaceKey({ deviceId: device.id, workspaceId: workspace.id })
      : undefined,
  );
  useLayoutEffect(() => {
    if (authenticated) drafts.limits(devices);
  }, [drafts, devices, authenticated]);
  return session ? (
    <SignedInWorkbench
      route={route}
      mobile={mobile}
      control={control}
      device={device}
      workspace={workspace}
      unavailable={unavailable}
      contextTitle={contextTitle}
      recents={recents}
      drafts={drafts}
      gitActions={gitActions}
      memories={memories}
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      sidebarWidth={sidebarWidth}
      setSidebarWidth={setSidebarWidth}
      error={error}
      setError={setError}
      terminalFocus={terminalFocus}
      onSignOut={signOut}
    />
  ) : (
    authentication
  );
}

interface WorkbenchError {
  cause: unknown;
  downloadPath?: string;
}

interface SignedInWorkbenchProps {
  route: ReturnType<typeof useRoute>;
  mobile: boolean;
  control: ReturnType<typeof useBrowserControlConnection>;
  device?: Device;
  workspace?: WorkspaceInfo;
  unavailable?: string;
  contextTitle: string;
  recents: RecentWorkspace[];
  drafts: DraftStore;
  gitActions: GitActions;
  memories: WorkspaceMemories;
  sidebarOpen: boolean;
  setSidebarOpen(open: boolean): void;
  sidebarWidth?: number;
  setSidebarWidth(width: number): void;
  error?: WorkbenchError;
  setError(error?: WorkbenchError): void;
  terminalFocus: ReturnType<typeof useTerminalFocus>;
  onSignOut(): Promise<void>;
}

function SignedInWorkbench({
  route,
  mobile,
  control,
  device,
  workspace,
  unavailable,
  contextTitle,
  recents,
  drafts,
  gitActions,
  memories,
  sidebarOpen,
  setSidebarOpen,
  sidebarWidth,
  setSidebarWidth,
  error,
  setError,
  terminalFocus,
  onSignOut,
}: SignedInWorkbenchProps) {
  const { t, i18n } = useTranslation();
  const { devices, loaded: devicesLoaded, connected, error: connectionError } = control;
  const [workspaceControls, setWorkspaceControls] = useState<HTMLDivElement | null>(null);
  const [workspaceTools, setWorkspaceTools] = useState<HTMLDivElement | null>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const mainContent = useRef<HTMLElement>(null);
  const focusContentAfterClose = useRef(false);

  const [binding, setBinding] = useState(false);
  const bindingReturnFocus = useRef<boolean | HTMLElement | null>(true);
  const [cliDialog, setCliDialog] = useState<{ target?: CliAttachTarget }>();
  const [openFiles, setOpenFiles] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [directoryDevice, setDirectoryDevice] = useState<{ device: Device; origin: string }>();
  const [action, setAction] = useState<DeviceAction>();
  const [portDevice, setPortDevice] = useState<string>();
  const [uploads, setUploads] = useState<
    {
      id: string;
      deviceId: string;
      workspaceId: string;
      folder: string;
      files: File[];
      label: string;
    }[]
  >([]);
  const [activeUpload, setActiveUpload] = useState<string>();
  const [fileOperation, setFileOperation] = useState<{
    deviceId: string;
    workspaceId: string;
    deviceName: string;
    workspaceName: string;
    folder: string;
    action: FileAction;
  }>();
  const [reports, setReports] = useState(new Map<string, ReceivedReport>());
  const [activationRequest, setActivationRequest] = useState(0);
  useEffect(function watchTerminalReports() {
    const receiveTerminalReports = (event: WindowEventMap["kiteline:event"]) => {
      const message = event.detail;
      if (message.type === "notices.reset") setReports(new Map());
      if (message.type === "terminal.notice")
        setReports((previous) => new Map(previous).set(reportKey(message), message));
      if (message.type === "notice.cleared")
        setReports((previous) => {
          const key = reportKey(message);
          if (previous.get(key)?.noticeId !== message.noticeId) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
    };
    window.addEventListener("kiteline:event", receiveTerminalReports);
    return () => window.removeEventListener("kiteline:event", receiveTerminalReports);
  }, []);
  const navigationReports = [...reports.values()]
    .filter((report) =>
      devices.some(
        (device) =>
          device.id === report.deviceId &&
          device.snapshot?.workspaces.some((workspace) => workspace.id === report.workspaceId),
      ),
    )
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const activateTerminal = useCallback(
    (deviceId: string, workspaceId: string, sessionId: string) => {
      void post(`/api/devices/${encodeURIComponent(deviceId)}/notices/activate`, {
        workspaceId,
        sessionId,
      }).catch((cause: unknown) => setError({ cause }));
    },
    [setError],
  );
  function openReport(report: ReceivedReport) {
    choose(workspaceDestination(report, "terminal", { session: report.sessionId }));
    // Repeated activation must still reveal a terminal when the URL is unchanged.
    setActivationRequest((value) => value + 1);
  }

  const routePath = currentPath();
  useEffect(
    function closeMobileNavigationAfterRouteChange() {
      setMobileNavigation(false);
    },
    [routePath],
  );
  useEffect(
    function closePortWhenDeviceChanges() {
      setPortDevice(undefined);
    },
    [route.deviceId],
  );
  const portTarget = devices.find((d) => d.id === portDevice);
  const directoryTarget = devices.find((item) => item.id === directoryDevice?.device.id);
  const directoryEnvironment =
    directoryTarget?.status === "online" ? directoryTarget.environment : undefined;
  const navigationVisible = !terminalFocus.active && (mobile ? mobileNavigation : sidebarOpen);
  const orphan =
    route.tool === "files" && route.deviceId && route.workspaceId && (!device || !workspace)
      ? drafts.find(
          {
            deviceId: route.deviceId,
            workspaceId: route.workspaceId,
            path: route.query.file ?? "",
          },
          route.query.draft,
        )
      : undefined;
  function choose(
    path: string,
    {
      restoreWorkspace = true,
      keyboard = false,
    }: { restoreWorkspace?: boolean; keyboard?: boolean } = {},
  ) {
    if (keyboard && mobile && mobileNavigation) focusContentAfterClose.current = true;
    const destination = parseRoute(new URL(path, window.location.origin));
    const saved =
      restoreWorkspace &&
      destination.deviceId &&
      destination.workspaceId &&
      Object.values(destination.query).every((value) => value === undefined)
        ? memories.get({ deviceId: destination.deviceId, workspaceId: destination.workspaceId })
            ?.presentation?.path
        : undefined;
    const target = saved ?? path;
    if (target !== currentPath()) navigate(target);
    setMobileNavigation(false);
    setError(undefined);
    if (keyboard && !(mobile && mobileNavigation))
      mainContent.current?.focus({ preventScroll: true });
  }
  function openBinding() {
    bindingReturnFocus.current = mobile && mobileNavigation ? navigationToggle.current : true;
    setMobileNavigation(false);
    setBinding(true);
  }
  const deviceActions: DeviceActions = {
    navigate: choose,
    addWorkspace: (device) => setDirectoryDevice({ device, origin: currentPath() }),
    openAction: setAction,
    openPort: setPortDevice,
  };
  const navigationProps = {
    reports: navigationReports,
    onReport: openReport,
    devices,
    drafts,
    actions: deviceActions,
    deviceId: device?.id,
    workspaceId: workspace?.id,
    tool: route.tool,
    onBind: openBinding,
  };
  const navigationButton = (
    <IconButton
      ref={navigationToggle}
      label={
        (navigationVisible ? t(($) => $.shell.collapseSidebar) : t(($) => $.shell.expandSidebar)) +
        (mobile && navigationReports.length
          ? " · " + t(($) => $.reports.count, { count: navigationReports.length })
          : "")
      }
      aria-expanded={navigationVisible}
      aria-controls="device-sidebar"
      className="relative"
      onClick={() => {
        if (terminalFocus.active) terminalFocus.exit();
        if (mobile) setMobileNavigation(true);
        else setSidebarOpen(!navigationVisible);
      }}
    >
      {navigationVisible ? <PanelLeftClose /> : <PanelLeftOpen />}
      {mobile && navigationReports.length > 0 && (
        <span className="absolute top-0 right-0 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
          {navigationReports.length}
        </span>
      )}
    </IconButton>
  );
  function renderMain() {
    if (!route.valid)
      return (
        <div className="p-6">
          {t(($) => $.shell.pageMissing)}
          <Button variant="ghost" onClick={() => choose("/devices")}>
            {t(($) => $.shell.backDevices)}
          </Button>
        </div>
      );
    if (route.tasks)
      return <TasksPage devices={devices} connected={connected} route={route.tasks} />;
    if (!route.deviceId)
      return (
        <Home
          devices={devices}
          loaded={devicesLoaded}
          connectionError={connectionError}
          recents={recents}
          onNavigate={choose}
          onBind={openBinding}
        />
      );
    if (orphan)
      return (
        <ViewBoundary key={orphan.id} active>
          <DraftView
            store={drafts}
            draft={orphan}
            targetOS={devices.find((device) => device.id === orphan.deviceId)?.environment?.os}
            unavailable={
              !device
                ? t(($) => $.shell.missingDeviceDraft)
                : t(($) => $.shell.missingWorkspaceDraft)
            }
          />
        </ViewBoundary>
      );
    if (!device)
      return (
        <div className="space-y-3 p-6">
          <p className="text-muted-foreground">{unavailable}</p>
          <Button variant="outline" onClick={() => choose("/devices")}>
            {t(($) => $.shell.backDevices)}
          </Button>
        </div>
      );
    if (route.workspaceId) {
      if (!workspace)
        return (
          <div className="space-y-3 p-6">
            <p className="text-muted-foreground">{unavailable}</p>
            <Button variant="outline" onClick={() => choose(devicePath(device.id))}>
              {t(($) => $.shell.backDevice)}
            </Button>
          </div>
        );
      return (
        <ViewBoundary
          key={workspaceKey({ deviceId: device.id, workspaceId: workspace.id })}
          active
          actions={
            <Button variant="outline" onClick={() => choose("/devices")}>
              <ArrowLeft />
              {t(($) => $.shell.backDevices)}
            </Button>
          }
        >
          <Workspace
            device={device}
            workspace={workspace}
            memory={memories.forTarget({ deviceId: device.id, workspaceId: workspace.id })}
            onLayout={memories.saveTerminalLayout}
            onActivateTerminal={activateTerminal}
            activationRequest={activationRequest}
            focusMode={terminalFocus}
            reports={navigationReports}
            onCliAttach={(target) => setCliDialog({ target })}
            store={drafts}
            actions={gitActions}
            controlsHost={workspaceControls}
            toolsHost={workspaceTools}
            navigationOpen={mobile && mobileNavigation}
            onOperation={(action, folder) =>
              setFileOperation({
                deviceId: device.id,
                workspaceId: workspace.id,
                deviceName: device.name,
                workspaceName: workspace.name,
                folder,
                action,
              })
            }
            onUpload={(files, folder) => {
              const id = newId();
              setUploads((old) => [
                ...old,
                {
                  id,
                  deviceId: device.id,
                  workspaceId: workspace.id,
                  folder,
                  files,
                  label: `${device.name} / ${workspace.name} / ${folder}`,
                },
              ]);
              setActiveUpload(id);
            }}
          />
        </ViewBoundary>
      );
    }
    return <DeviceDetail key={device.id} device={device} actions={deviceActions} />;
  }
  return (
    <>
      <a
        href="#workbench-main"
        onClick={(event) => {
          event.preventDefault();
          mainContent.current?.focus({ preventScroll: true });
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded focus:border focus:border-border focus:bg-background focus:px-4 focus:py-3 focus:text-sm"
      >
        {t(($) => $.shell.skipToContent)}
      </a>
      <div
        data-terminal-focus={terminalFocus.active ? "" : undefined}
        className="fixed top-[var(--app-top,0px)] left-0 flex h-[var(--app-height,100vh)] w-full min-h-0 overflow-hidden bg-background"
      >
        <EdgePanel
          desktopWidth={sidebarWidth}
          onDesktopWidthChange={setSidebarWidth}
          id="device-sidebar"
          side="left"
          mobile={mobile}
          open={navigationVisible}
          onClose={() => setMobileNavigation(false)}
          returnFocus={() => {
            if (focusContentAfterClose.current) {
              focusContentAfterClose.current = false;
              return mainContent.current;
            }
            return navigationToggle.current;
          }}
          label={t(($) => $.shell.deviceWorkspaces)}
          className="workbench-sidebar flex min-h-0 shrink-0 flex-col border-r border-border bg-muted"
        >
          <div className="flex min-h-12 shrink-0 items-center gap-2 px-4">
            <span className="flex size-6 items-center justify-center rounded bg-foreground text-sm font-semibold text-background">
              k
            </span>
            <strong className="min-w-0 flex-1 text-sm">Kiteline</strong>
            {mobile && (
              <IconButton
                label={t(($) => $.shell.returnToContent)}
                onClick={() => setMobileNavigation(false)}
              >
                <ArrowLeft />
              </IconButton>
            )}
          </div>
          <div className="shrink-0 space-y-1 px-2 pb-4">
            <Button
              variant="ghost"
              className={
                "w-full justify-start " +
                (route.valid && !route.tasks && !route.deviceId
                  ? "bg-background text-primary hover:bg-background"
                  : "")
              }
              aria-current={route.valid && !route.tasks && !route.deviceId ? "page" : undefined}
              onClick={(event) => choose("/devices", { keyboard: event.detail === 0 })}
            >
              <LayoutDashboard />
              {t(($) => $.shell.home)}
            </Button>
            <Button
              variant="ghost"
              className={
                "w-full justify-start " +
                (route.tasks ? "bg-background text-primary hover:bg-background" : "")
              }
              aria-current={route.tasks ? "page" : undefined}
              onClick={(event) => choose(tasksPath(), { keyboard: event.detail === 0 })}
            >
              <CalendarClock />
              <span className="min-w-0 flex-1 truncate text-left">
                {t(($) => $.schedules.title)}
              </span>
            </Button>
          </div>
          <div className="scroll-area min-h-0 flex-1 overflow-auto">
            <DeviceNavigation {...navigationProps} />
          </div>
          <div className="shrink-0 border-t border-border p-2">
            <Menu>
              <MenuTrigger render={<Button variant="ghost" className="w-full justify-start" />}>
                <Settings />
                <span className="flex-1 text-left">{t(($) => $.shell.settings)}</span>
                {!!uploads.length && (
                  <span
                    aria-label={t(($) => $.shell.uploadStatus, { count: uploads.length })}
                    className="text-xs text-primary"
                  >
                    {uploads.length}
                  </span>
                )}
              </MenuTrigger>
              <MenuContent>
                {!(workspace && route.tool === "terminal") && (
                  <MenuItem
                    onClick={() => {
                      if (mobile) setMobileNavigation(false);
                      void terminalFocus.toggleFullscreen();
                    }}
                  >
                    {t(($) =>
                      terminalFocus.fullscreen
                        ? $.terminal.exitFullscreen
                        : $.terminal.enterFullscreen,
                    )}
                  </MenuItem>
                )}
                <MenuItem onClick={() => setCliDialog({})}>
                  <Terminal />
                  {t(($) => $.cliSetup.title)}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMobileNavigation(false);
                    setOpenFiles(true);
                  }}
                >
                  <FilesIcon />
                  {t(($) => $.files.openFiles)}
                </MenuItem>
                <div className="my-1 border-t border-border" />
                <LanguageOptions />
                <div className="my-1 border-t border-border" />
                <AppearanceOptions />
                <div className="my-1 border-t border-border" />
                {uploads.map((item) => (
                  <MenuItem key={item.id} onClick={() => setActiveUpload(item.id)}>
                    <Upload />
                    <span className="min-w-0 break-all" title={item.label}>
                      {item.label} · {item.files.length.toLocaleString(i18n.resolvedLanguage)}
                    </span>
                  </MenuItem>
                ))}
                <MenuItem onClick={() => void onSignOut()}>
                  <LogOut />
                  {t(($) => $.shell.logout)}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </EdgePanel>
        <main
          id="workbench-main"
          ref={mainContent}
          tabIndex={-1}
          aria-label={t(($) => $.shell.mainContent)}
          className="flex min-w-0 flex-1 flex-col outline-none desk:min-w-[400px]"
        >
          <ReleaseNotice />
          <header
            hidden={terminalFocus.active}
            className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-1 max-desk:min-h-11"
          >
            {!terminalFocus.active && navigationButton}
            {workspace && (
              <span className="hidden min-w-0 max-w-40 items-center gap-2 text-xs text-muted-foreground desk:flex">
                <span className="truncate">{device?.name}</span>
                <ChevronRight size={12} className="shrink-0" />
              </span>
            )}
            <strong
              className="min-w-0 flex-1 truncate text-xs font-medium"
              title={workspace ? `${device?.name} · ${workspace.name}` : contextTitle}
            >
              {workspace?.name ?? contextTitle}
            </strong>
            <div ref={setWorkspaceControls} className="flex shrink-0 items-center gap-1" />
          </header>
          {route.valid && !route.tasks && device && (!route.workspaceId || workspace) && (
            <AgentReleaseNotice key={`agent-release:${device.id}`} device={device} />
          )}
          {!!(error || connectionError) && (
            <div
              role="alert"
              className="workbench-notice flex shrink-0 items-start gap-2 border-b border-border bg-danger-soft px-4 py-2 text-sm text-destructive"
            >
              <div className="min-w-0 flex-1 break-words">
                {error?.downloadPath
                  ? t(($) => $.shell.downloadFailed, {
                      path: error.downloadPath,
                      error: errorMessage(error.cause),
                    })
                  : errorMessage(error ? error.cause : connectionError)}
                <ErrorDetails error={error ? error.cause : connectionError} />
              </div>
              {!!error && (
                <IconButton label={t(($) => $.common.dismiss)} onClick={() => setError(undefined)}>
                  <X />
                </IconButton>
              )}
            </div>
          )}
          {terminalFocus.error && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-sm text-destructive"
            >
              <span className="flex-1">{t(($) => $.terminal[terminalFocus.error!])}</span>
              <IconButton label={t(($) => $.common.dismiss)} onClick={terminalFocus.dismiss}>
                <X />
              </IconButton>
            </div>
          )}
          {renderMain()}
        </main>
        <div ref={setWorkspaceTools} className="contents" />
      </div>
      <OpenFiles store={drafts} devices={devices} open={openFiles} onOpenChange={setOpenFiles} />
      {cliDialog && (
        <CliDialog
          devices={devices}
          target={cliDialog.target}
          onClose={() => setCliDialog(undefined)}
        />
      )}
      {portTarget && (
        <PortDialog
          key={portTarget.id}
          device={portTarget}
          onClose={() => setPortDevice(undefined)}
        />
      )}
      <Dialog open={binding} onOpenChange={setBinding}>
        {binding && (
          <BindingDialog
            devices={devices}
            connected={connected}
            finalFocus={() => bindingReturnFocus.current}
            onDevice={(id) => {
              setBinding(false);
              choose(devicePath(id));
            }}
            onAddWorkspace={(device) => {
              bindingReturnFocus.current = false;
              setBinding(false);
              deviceActions.addWorkspace(device);
            }}
          />
        )}
      </Dialog>
      {uploads.map((item) => (
        <UploadDialog
          key={item.id}
          {...item}
          open={activeUpload === item.id}
          onHide={() => setActiveUpload(undefined)}
          onClose={() => {
            setUploads((old) => old.filter((upload) => upload !== item));
            setActiveUpload(undefined);
          }}
          onWritten={(path) =>
            emit("kiteline:file-written", {
              deviceId: item.deviceId,
              workspaceId: item.workspaceId,
              path,
            })
          }
        />
      ))}
      {fileOperation && (
        <FileOperationDialog
          {...fileOperation}
          store={drafts}
          onClose={() => setFileOperation(undefined)}
          onResult={(items) => {
            const { deviceId, workspaceId, action } = fileOperation;
            emit("kiteline:files-operated", { deviceId, workspaceId, kind: action.kind, items });
          }}
        />
      )}
      {directoryDevice && (
        <DirectoryDialog
          // Reconnect or environment changes restart browsing and release the old cursor.
          key={`${directoryTarget?.id}:${directoryTarget?.lastSeenAt}:${JSON.stringify(directoryEnvironment)}`}
          deviceId={directoryDevice.device.id}
          environment={directoryEnvironment}
          onClose={() => setDirectoryDevice(undefined)}
          onAdded={(w) => {
            const id = directoryDevice.device.id;
            setDirectoryDevice(undefined);
            if (currentPath() === directoryDevice.origin) choose(workspacePath(id, w.id));
          }}
        />
      )}
      {action && (
        <DeviceActionDialog
          action={action}
          onClose={() => setAction(undefined)}
          onNavigate={(path) => choose(path, { restoreWorkspace: false })}
        />
      )}
    </>
  );
}
