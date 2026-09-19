import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageMenu } from "./components/language-menu";
import {
  ChevronRight,
  Folder,
  GitBranch,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Server,
  Terminal,
  X,
  Upload,
  Globe,
} from "lucide-react";
import type { BrowserEvent, Device } from "@kiteline/shared/protocol";
import { Auth, type Session } from "./auth";
import { ApiError, api, errorMessage, post } from "./lib/api";
import { ErrorDetails, ErrorNotice } from "./components/error-notice";
import {
  currentPath,
  devicePath,
  navigate,
  navigateWorkspace,
  useRoute,
  workspacePath,
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
import { DeviceList, DeviceDetail } from "./devices/device-views";
import { WorkspaceTerminal } from "./terminal/sessions";
import type { TerminalLayout } from "./terminal/groups";
import { Files } from "./files/files";
import { GitTool } from "./git/git";
import { GitActions } from "./git/actions";
import { WatchStatus } from "./components/watch-status";
import { DraftStore, isDirty } from "./files/drafts";
import { DraftView } from "./files/draft-view";
import { OpenFiles } from "./files/open-files";
import { UploadDialog } from "./files/upload-dialog";
import { returnToService } from "./lib/login-return";
import { PortDialog } from "./devices/port-dialog";
import { ReleaseNotice } from "./components/release-notice";

export function App() {
  const { t, i18n } = useTranslation();
  const terminalLayouts = useRef(new Map<string, TerminalLayout>());
  const [drafts] = useState(() => new DraftStore());
  const [gitActions] = useState(() => new GitActions());
  const route = useRoute();
  const [session, setSession] = useState<Session>();
  const [initialized, setInitialized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<unknown>();
  const [error, setError] = useState<{ cause: unknown; downloadPath?: string }>();
  const [binding, setBinding] = useState(false);
  const [picker, setPicker] = useState(false);
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
  const {
    devices,
    connected,
    error: connectionError,
    refresh,
  } = useDevices(!!session, route.deviceId, route.workspaceId, setSession);
  const device = devices.find((d) => d.id === route.deviceId);
  const workspace = device?.snapshot?.workspaces.find((w) => w.id === route.workspaceId);
  const orphan =
    route.tool === "files" &&
    route.deviceId &&
    route.workspaceId &&
    (!device || !workspace || device.status === "revoked")
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
    if (session) drafts.limits(devices, session.draftTotalBytes);
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
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () =>
      document.documentElement.style.setProperty(
        "--app-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  async function loadSession() {
    setLoading(true);
    setAuthError("");
    try {
      setSession(await api<Session>("/api/session"));
      returnToService();
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthenticated") {
        try {
          setInitialized((await api<{ initialized: boolean }>("/api/bootstrap")).initialized);
        } catch (error) {
          setAuthError(error);
        }
      } else setAuthError(error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadSession();
  }, []);
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
    };
    window.addEventListener("kiteline:unauthenticated", expire);
    return () => window.removeEventListener("kiteline:unauthenticated", expire);
  }, []);
  async function logout() {
    if (drafts.snapshot().some(isDirty) && !window.confirm(t(($) => $.shell.discardLogout))) return;
    try {
      await post("/api/logout");
      terminalLayouts.current.clear();
      drafts.clear();
      gitActions.clear();
      setUploads([]);
      setActiveUpload(undefined);
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
  const navigation = (
    <DeviceNavigation
      devices={devices}
      deviceId={device?.id}
      workspaceId={workspace?.id}
      tool={route.tool}
      onNavigate={choose}
      onBind={() => {
        setPicker(false);
        setBinding(true);
      }}
    />
  );
  if (loading || authError)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-muted p-5">
        <Terminal className="text-primary" />
        <div role={authError ? "alert" : "status"}>
          {authError ? <ErrorNotice error={authError} /> : t(($) => $.common.connecting)}
        </div>
        {!!authError && (
          <Button onClick={() => void loadSession()}>
            <RefreshCw />
            {t(($) => $.common.retry)}
          </Button>
        )}
      </div>
    );
  if (!session)
    return (
      <Auth
        initialized={initialized}
        onLogin={(value) => {
          setSession(value);
          setInitialized(true);
          returnToService();
        }}
      />
    );
  return (
    <>
      <div className="flex h-[var(--app-height,100dvh)] min-h-0 flex-col overflow-hidden">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3 max-[959px]:flex-wrap max-[959px]:gap-y-0">
          <button
            className="hidden w-48 shrink-0 items-center gap-2 text-sm font-semibold min-[960px]:flex"
            onClick={() => choose("/devices")}
          >
            <span className="flex size-6 items-center justify-center rounded bg-primary text-white">
              <Terminal size={17} />
            </span>
            Kiteline
          </button>
          <Dialog open={picker} onOpenChange={setPicker}>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-[960px]:hidden"
                  aria-label={t(($) => $.shell.switchWorkspace)}
                />
              }
            >
              <Server />
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t(($) => $.shell.deviceWorkspaces)}</DialogTitle>
              </DialogHeader>
              <div className="scroll-area overflow-auto">{navigation}</div>
            </DialogContent>
          </Dialog>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-sm max-[959px]:order-last max-[959px]:basis-full max-[959px]:pt-0">
            <button
              onClick={() => choose(device ? devicePath(device.id) : "/devices")}
              className="max-w-full truncate"
              title={device?.name}
            >
              {device?.name ?? t(($) => $.common.devices)}
            </button>
            {workspace && (
              <>
                <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
                <span className="max-w-full truncate font-medium" title={workspace.path}>
                  {workspace.name}
                </span>
              </>
            )}
          </div>
          <span
            className="status-dot max-[959px]:ml-auto"
            data-status={connected ? "online" : "offline"}
            title={connected ? t(($) => $.common.connected) : t(($) => $.common.disconnected)}
            aria-label={connected ? t(($) => $.common.connected) : t(($) => $.common.disconnected)}
          />
          <OpenFiles store={drafts} />
          {device && device.status !== "revoked" && (
            <IconButton label={t(($) => $.shell.openPort)} onClick={() => setPortDevice(device.id)}>
              <Globe />
            </IconButton>
          )}
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
          <LanguageMenu />
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label={t(($) => $.shell.ownerMenu)} />
              }
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent>
              <MenuItem onClick={() => void logout()}>
                <LogOut />
                {t(($) => $.shell.logout)}
              </MenuItem>
            </MenuContent>
          </Menu>
        </header>
        <ReleaseNotice />
        <div className="flex min-h-0 flex-1">
          <aside className="desktop-rail scroll-area shrink-0 overflow-auto border-r border-border bg-muted/60">
            {navigation}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
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
            ) : !route.deviceId ? (
              <DeviceList devices={devices} onNavigate={choose} onBind={() => setBinding(true)} />
            ) : orphan ? (
              <DraftView
                key={orphan.id}
                store={drafts}
                draft={orphan}
                unavailable={
                  device?.status === "revoked"
                    ? t(($) => $.shell.revokedDraft)
                    : t(($) => $.shell.missingWorkspaceDraft)
                }
              />
            ) : !device ? (
              <p className="p-6 text-muted-foreground">
                {connected ? t(($) => $.shell.deviceMissing) : t(($) => $.shell.connectingDevice)}
              </p>
            ) : route.workspaceId ? (
              !workspace ? (
                <p className="p-6 text-muted-foreground">{t(($) => $.shell.workspaceRemoved)}</p>
              ) : (
                <>
                  <div
                    role="tablist"
                    aria-label={t(($) => $.shell.tools)}
                    className="flex shrink-0 gap-5 border-b border-border bg-muted/60 px-4 max-[959px]:gap-0 max-[959px]:px-0"
                  >
                    {[
                      {
                        id: "terminal" as const,
                        name: t(($) => $.common.terminal),
                        icon: Terminal,
                      },
                      { id: "files" as const, name: t(($) => $.common.files), icon: Folder },
                      { id: "git" as const, name: t(($) => $.common.git), icon: GitBranch },
                    ].map((tool) => (
                      <button
                        key={tool.id}
                        role="tab"
                        aria-selected={route.tool === tool.id}
                        className="tool-tab flex min-h-10 items-center justify-center gap-2 text-sm"
                        onClick={() =>
                          navigateWorkspace(
                            { deviceId: device.id, workspaceId: workspace.id },
                            tool.id,
                          )
                        }
                      >
                        <tool.icon size={15} />
                        {tool.name}
                      </button>
                    ))}
                  </div>
                  <WatchStatus deviceId={device.id} workspaceId={workspace.id} />
                  <WorkspaceTerminal
                    key={`${device.id}:${workspace.id}`}
                    device={device}
                    workspace={workspace}
                    visible={route.tool === "terminal"}
                    layouts={terminalLayouts.current}
                  >
                    <Files
                      device={device}
                      workspace={workspace}
                      visible={route.tool === "files"}
                      store={drafts}
                      onUpload={(files, folder) => {
                        const id = crypto.randomUUID();
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
                onPort={() => setPortDevice(device.id)}
              />
            )}
          </main>
        </div>
      </div>
      {device && portDevice === device.id && device.status !== "revoked" && (
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
      {directoryDevice && (
        <DirectoryDialog
          deviceId={directoryDevice.device.id}
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
            setAction(undefined);
            void refresh().catch((error: unknown) => setError({ cause: error }));
          }}
        />
      )}
    </>
  );
}
