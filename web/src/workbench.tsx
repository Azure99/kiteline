import { newId } from "./lib/id";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { trackViewport } from "./lib/viewport";
import { LanguageOptions } from "./components/language-menu";
import {
  ChevronDown,
  LogOut,
  MoreHorizontal,
  Server,
  Terminal,
  X,
  Upload,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  Files as FilesIcon,
  CalendarClock,
} from "lucide-react";
import type { BrowserEvent, Device } from "@kiteline/shared/protocol";
import type { Session } from "./auth";
import { ApiError, errorMessage, post } from "./lib/api";
import { ErrorDetails } from "./components/error-notice";
import {
  currentPath,
  devicePath,
  navigate,
  useRoute,
  workspacePath,
  schedulePath,
} from "./lib/navigation";
import { useDevices } from "./use-devices";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./components/ui/menu";
import { IconButton } from "./components/icon-button";
import { BindingDialog } from "./devices/binding-dialog";
import { DirectoryDialog } from "./devices/directory-dialog";
import { DeviceActionDialog, type DeviceAction } from "./devices/device-actions";

import { DeviceNavigation } from "./devices/device-navigation";
import { Home, DeviceDetail } from "./devices/device-views";
import { useRecentWorkspaces } from "./devices/recent-workspaces";
import { WorkspaceTerminal } from "./terminal/sessions";
import type { TerminalLayout } from "./terminal/groups";
import { GitActions } from "./git/actions";
import { DraftStore, isDirty } from "./files/drafts";
import { DraftView } from "./files/draft-view";
import { OpenFiles } from "./files/open-files";
import { UploadDialog } from "./files/upload-dialog";
import {
  FileOperationDialog,
  type FileAction,
  type FileOperationResult,
} from "./files/operation-dialog";
import { PortDialog } from "./devices/port-dialog";
import { ReleaseNotice } from "./components/release-notice";
import { AgentReleaseNotice } from "./devices/agent-release-notice";
import { useTerminalFocus } from "./terminal/use-terminal-focus";
import { deferredView, ViewBoundary } from "./components/deferred-view";

const Files = deferredView(async () => ({ default: (await import("./files/files")).Files }), {
  active: (props) => props.visible,
});
const GitTool = deferredView(async () => ({ default: (await import("./git/git")).GitTool }), {
  active: (props) => props.visible,
});
const ScheduledTasksPage = deferredView(async () => ({
  default: (await import("./schedules/scheduled-tasks")).ScheduledTasksPage,
}));

export function Workbench({
  session,
  setSession,
  authentication,
}: {
  session?: Session;
  setSession(session?: Session): void;
  authentication: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const terminalLayouts = useRef(new Map<string, TerminalLayout>());
  const [drafts] = useState(() => new DraftStore());
  const [gitActions] = useState(() => new GitActions());
  const route = useRoute();
  const [error, setError] = useState<{ cause: unknown; downloadPath?: string }>();
  const [binding, setBinding] = useState(false);
  const [picker, setPicker] = useState(false);
  const [openFiles, setOpenFiles] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [directoryDevice, setDirectoryDevice] = useState<{ device: Device; origin: string }>();
  const [action, setAction] = useState<DeviceAction>();
  const [portDevice, setPortDevice] = useState<string>();
  useEffect(() => setPortDevice(undefined), [route.deviceId]);
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
  const {
    devices,
    loaded: devicesLoaded,
    connected,
    error: connectionError,
    refresh,
  } = useDevices(!!session, route.deviceId, route.workspaceId, setSession);
  const recents = useRecentWorkspaces(route, devices, devicesLoaded, !!session);
  const device = devices.find((d) => d.id === route.deviceId);
  const directoryTarget = devices.find((item) => item.id === directoryDevice?.device.id);
  const directoryEnvironment =
    directoryTarget?.status === "online" ? directoryTarget.environment : undefined;
  const workspace = device?.snapshot?.workspaces.find((w) => w.id === route.workspaceId);
  const terminalPage =
    !!session && route.valid && !!device && !!workspace && route.tool === "terminal";
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-terminal-active", terminalPage);
    return () => document.documentElement.removeAttribute("data-terminal-active");
  }, [terminalPage]);
  const terminalFocus = useTerminalFocus(
    session && route.valid && route.tool === "terminal" && device && workspace
      ? `${device.id}:${workspace.id}`
      : undefined,
  );
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
  useLayoutEffect(() => {
    if (session) drafts.limits(devices);
  }, [drafts, devices, session]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (drafts.snapshot().some(isDirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const failed = (event: Event) => {
      const message = (event as CustomEvent<BrowserEvent>).detail;
      if (message.type === "channel.failed") {
        drafts.fileFailed(message.channelId, message.error);
        if (message.purpose === "download" && message.error.code !== "cancelled")
          setError({
            cause: new ApiError(
              message.error.code,
              message.error.message,
              undefined,
              message.error.details,
            ),
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
  }, [drafts]);
  useEffect(trackViewport, []);
  useEffect(() => {
    const expire = () => {
      setSession(undefined);
      setBinding(false);
      setPicker(false);
      setDirectoryDevice(undefined);
      setAction(undefined);
      setPortDevice(undefined);
      setUploads([]);
      setActiveUpload(undefined);
      setFileOperation(undefined);
    };
    window.addEventListener("kiteline:unauthenticated", expire);
    return () => window.removeEventListener("kiteline:unauthenticated", expire);
  }, [setSession]);
  async function logout() {
    if (drafts.snapshot().some(isDirty) && !window.confirm(t(($) => $.shell.discardLogout))) return;
    try {
      await post("/api/logout");
      terminalLayouts.current.clear();
      drafts.clear();
      gitActions.clear();
      setUploads([]);
      setActiveUpload(undefined);
      setFileOperation(undefined);
      setSession(undefined);
    } catch (error) {
      setError({ cause: error });
    }
  }
  function choose(path: string) {
    navigate(path);
    setPicker(false);
    setError(undefined);
  }
  const navigationProps = {
    devices,
    deviceId: device?.id,
    workspaceId: workspace?.id,
    tool: route.tool,
    onNavigate: choose,
    onBind: () => {
      setPicker(false);
      setBinding(true);
    },
  };
  if (!session) return authentication;
  return (
    <>
      <div
        data-terminal-focus={terminalFocus.active ? "" : undefined}
        className="fixed top-[var(--app-top,0px)] left-0 flex h-[var(--app-height,100vh)] w-full min-h-0 flex-col overflow-hidden bg-background"
      >
        <header
          hidden={terminalFocus.active}
          className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3 max-[959px]:gap-1 max-[959px]:px-2"
        >
          <div className="flex shrink-0 items-center gap-2">
            <IconButton
              className="max-[959px]:hidden"
              label={
                sidebarOpen ? t(($) => $.shell.collapseSidebar) : t(($) => $.shell.expandSidebar)
              }
              aria-expanded={sidebarOpen}
              aria-controls="device-sidebar"
              onClick={() => setSidebarOpen((open) => !open)}
            >
              {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </IconButton>
            <button
              className="flex min-h-9 items-center justify-center gap-2 text-sm font-semibold max-[959px]:size-11"
              aria-label={t(($) => $.home.open)}
              onClick={() => choose("/devices")}
            >
              <span className="flex size-6 items-center justify-center rounded bg-primary text-white">
                <Terminal size={17} />
              </span>
              <span className="max-[959px]:hidden">Kiteline</span>
            </button>
          </div>
          <Dialog open={picker} onOpenChange={setPicker}>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 shrink justify-start px-2 text-left"
                  aria-label={t(($) => $.shell.switchWorkspace)}
                  title={workspace ? `${device?.name} / ${workspace.name}` : device?.name}
                />
              }
            >
              <Server className="max-[360px]:hidden" />
              <span className="flex min-w-0 flex-col min-[960px]:flex-row min-[960px]:items-center min-[960px]:gap-2">
                <span className="truncate">
                  {workspace?.name ?? device?.name ?? t(($) => $.common.devices)}
                </span>
                {workspace && (
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {device?.name}
                  </span>
                )}
              </span>
              <ChevronDown />
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t(($) => $.shell.deviceWorkspaces)}</DialogTitle>
              </DialogHeader>
              <div className="scroll-area overflow-auto">
                <DeviceNavigation {...navigationProps} showPaths />
              </div>
            </DialogContent>
          </Dialog>
          <span
            className="status-dot"
            data-status={connected ? "online" : "offline"}
            title={connected ? t(($) => $.common.connected) : t(($) => $.common.disconnected)}
            aria-label={connected ? t(($) => $.common.connected) : t(($) => $.common.disconnected)}
          />
          <IconButton
            label={t(($) => $.schedules.title)}
            aria-current={route.schedule ? "page" : undefined}
            className={route.schedule ? "bg-muted text-primary" : undefined}
            onClick={() => {
              if (!route.schedule) choose(schedulePath({ filter: device?.id }));
            }}
          >
            <CalendarClock />
          </IconButton>
          {device && (
            <IconButton label={t(($) => $.shell.openPort)} onClick={() => setPortDevice(device.id)}>
              <Globe />
            </IconButton>
          )}
          <div className="hidden items-center gap-2 min-[960px]:flex">
            {!!uploads.length && (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t(($) => $.shell.uploadStatus, { count: uploads.length })}
                    />
                  }
                >
                  <Upload />
                </MenuTrigger>
                <MenuContent>
                  {uploads.map((item) => (
                    <MenuItem key={item.id} onClick={() => setActiveUpload(item.id)}>
                      <span className="min-w-0 break-all" title={item.label}>
                        {item.label} · {item.files.length.toLocaleString(i18n.resolvedLanguage)}
                      </span>
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )}
          </div>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative"
                  aria-label={t(($) => $.shell.ownerMenu)}
                />
              }
            >
              <MoreHorizontal />
              {!!uploads.length && (
                <span
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary min-[960px]:hidden"
                  aria-label={t(($) => $.shell.uploadStatus, { count: uploads.length })}
                />
              )}
            </MenuTrigger>
            <MenuContent>
              <MenuItem onClick={() => setOpenFiles(true)}>
                <FilesIcon />
                {t(($) => $.files.openFiles)}
              </MenuItem>
              <div className="my-1 border-t border-border" />
              <LanguageOptions />
              <div className="my-1 border-t border-border" />
              <div className="min-[960px]:hidden">
                {uploads.map((item) => (
                  <MenuItem key={item.id} onClick={() => setActiveUpload(item.id)}>
                    <Upload />
                    <span className="min-w-0 break-all">
                      {item.label} · {item.files.length.toLocaleString(i18n.resolvedLanguage)}
                    </span>
                  </MenuItem>
                ))}
              </div>
              <MenuItem onClick={() => void logout()}>
                <LogOut />
                {t(($) => $.shell.logout)}
              </MenuItem>
            </MenuContent>
          </Menu>
        </header>
        <ReleaseNotice />
        <div className="flex min-h-0 flex-1">
          <aside
            id="device-sidebar"
            hidden={!sidebarOpen || terminalFocus.active}
            className="desktop-rail scroll-area shrink-0 overflow-auto border-r border-border bg-muted/60"
          >
            <DeviceNavigation {...navigationProps} />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            {route.valid && !route.schedule && device && (!route.workspaceId || workspace) && (
              <AgentReleaseNotice key={`agent-release:${device.id}`} device={device} />
            )}
            {!!(error || connectionError) && (
              <div
                role="alert"
                className="workbench-notice flex shrink-0 items-start gap-2 border-b border-border bg-red-50 px-4 py-2 text-sm text-destructive"
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
                  <IconButton
                    label={t(($) => $.common.dismiss)}
                    onClick={() => setError(undefined)}
                  >
                    <X />
                  </IconButton>
                )}
              </div>
            )}
            {!route.valid ? (
              <div className="p-6">
                {t(($) => $.shell.pageMissing)}
                <Button variant="ghost" onClick={() => choose("/devices")}>
                  {t(($) => $.shell.backDevices)}
                </Button>
              </div>
            ) : route.schedule ? (
              <ScheduledTasksPage devices={devices} connected={connected} route={route.schedule} />
            ) : !route.deviceId ? (
              <Home
                devices={devices}
                loaded={devicesLoaded}
                connectionError={connectionError}
                recents={recents}
                onNavigate={choose}
                onBind={() => setBinding(true)}
              />
            ) : orphan ? (
              <ViewBoundary key={orphan.id} active>
                <DraftView
                  store={drafts}
                  draft={orphan}
                  unavailable={
                    !device
                      ? t(($) => $.shell.missingDeviceDraft)
                      : t(($) => $.shell.missingWorkspaceDraft)
                  }
                />
              </ViewBoundary>
            ) : !device ? (
              <p className="p-6 text-muted-foreground">
                {connected ? t(($) => $.shell.deviceMissing) : t(($) => $.shell.connectingDevice)}
              </p>
            ) : route.workspaceId ? (
              !workspace ? (
                <p className="p-6 text-muted-foreground">{t(($) => $.shell.workspaceRemoved)}</p>
              ) : (
                <>
                  <WorkspaceTerminal
                    key={`${device.id}:${workspace.id}`}
                    device={device}
                    workspace={workspace}
                    visible={route.tool === "terminal"}
                    layouts={terminalLayouts.current}
                    focusMode={terminalFocus}
                  >
                    <Files
                      device={device}
                      workspace={workspace}
                      visible={route.tool === "files"}
                      store={drafts}
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
                    <GitTool
                      device={device}
                      workspace={workspace}
                      visible={route.tool === "git"}
                      store={drafts}
                      actions={gitActions}
                    />
                  </WorkspaceTerminal>
                </>
              )
            ) : (
              <DeviceDetail
                key={device.id}
                device={device}
                onNavigate={choose}
                onAdd={(device) => setDirectoryDevice({ device, origin: currentPath() })}
                onAction={setAction}
              />
            )}
          </main>
        </div>
      </div>
      <OpenFiles store={drafts} open={openFiles} onOpenChange={setOpenFiles} />
      {device && portDevice === device.id && (
        <PortDialog key={device.id} device={device} onClose={() => setPortDevice(undefined)} />
      )}
      <Dialog open={binding} onOpenChange={setBinding}>
        {binding && (
          <BindingDialog
            devices={devices}
            connected={connected}
            onDevice={(id) => {
              setBinding(false);
              choose(devicePath(id));
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
            window.dispatchEvent(
              new CustomEvent("kiteline:file-written", {
                detail: { deviceId: item.deviceId, workspaceId: item.workspaceId, path },
              }),
            )
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
            window.dispatchEvent(
              new CustomEvent<FileOperationResult>("kiteline:files-operated", {
                detail: { deviceId, workspaceId, kind: action.kind, items },
              }),
            );
          }}
        />
      )}
      {directoryDevice && (
        <DirectoryDialog
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
          onDone={() => {
            void refresh().catch((error: unknown) => setError({ cause: error }));
          }}
        />
      )}
    </>
  );
}
