import { useTranslation } from "react-i18next";
import { agentVersionMismatch } from "../lib/release";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Server,
  Settings,
  Trash2,
  Download,
  FileText,
  GitBranch,
  Terminal,
  CalendarClock,
} from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { devicePath, workspacePath, schedulePath } from "../lib/navigation";
import type { DeviceAction } from "./device-actions";
import { useEffect, useRef, useState } from "react";
import { TerminalSettings } from "../terminal/settings";
import { rpc } from "../lib/api";
import { UpgradeDialog } from "./upgrade-dialog";
import type { RecentWorkspace } from "./recent-workspaces";
import { SessionFinder, type SessionObservation } from "./session-finder";

const toolIcons = { terminal: Terminal, files: FileText, git: GitBranch };

export function Home({
  devices,
  loaded,
  connectionError,
  recents,
  onNavigate,
  onBind,
}: {
  devices: Device[];
  loaded: boolean;
  connectionError?: unknown;
  recents: RecentWorkspace[];
  onNavigate: (path: string) => void;
  onBind: () => void;
}) {
  const { t } = useTranslation();
  const recentTargets = recents.flatMap((entry) => {
    const device = devices.find((item) => item.id === entry.deviceId && item.status !== "revoked");
    const workspace = device?.snapshot?.workspaces.find((item) => item.id === entry.workspaceId);
    return device && workspace ? [{ entry, device, workspace }] : [];
  });

  return (
    <section className="scroll-area overflow-auto p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">Kiteline</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => onNavigate(schedulePath())}>
            <CalendarClock />
            {t(($) => $.schedules.title)}
          </Button>
          <Button onClick={() => onBind()}>
            <Plus />
            {t(($) => $.devices.bind)}
          </Button>
        </div>
      </div>
      {recentTargets.length > 0 && (
        <section className="mb-7" aria-label={t(($) => $.home.recentWorkspaces)}>
          <h2 className="mb-3 text-sm font-semibold">{t(($) => $.home.recentWorkspaces)}</h2>
          <div className="divide-y divide-border border-y border-border">
            {recentTargets.map(({ entry, device, workspace }) => {
              const ToolIcon = toolIcons[entry.lastTool];
              return (
                <button
                  key={`${device.id}:${workspace.id}`}
                  className="flex min-h-14 w-full items-center gap-3 py-2 text-left hover:bg-muted"
                  onClick={() => onNavigate(workspacePath(device.id, workspace.id, entry.lastTool))}
                >
                  <Folder size={18} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={workspace.name}>
                      {workspace.name}
                    </span>
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={`${device.name} · ${workspace.path}`}
                    >
                      {device.name} · {workspace.path}
                    </span>
                  </span>
                  <span
                    className="status-dot shrink-0"
                    data-status={device.status}
                    aria-label={t(($) => $.common[device.status])}
                  />
                  <ToolIcon
                    size={16}
                    className="shrink-0 text-muted-foreground"
                    aria-label={t(($) => $.common[entry.lastTool])}
                  />
                  <ChevronRight size={15} className="shrink-0" />
                </button>
              );
            })}
          </div>
        </section>
      )}
      <h2 className="mb-3 text-sm font-semibold">{t(($) => $.common.devices)}</h2>
      {!loaded ? (
        <p className="py-8 text-center text-muted-foreground">
          {connectionError ? t(($) => $.common.disconnected) : t(($) => $.common.loading)}
        </p>
      ) : devices.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground">
          <Monitor size={30} className="mx-auto mb-3" />
          <p>{t(($) => $.devices.noDevices)}</p>
        </div>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {devices.map((d) => (
            <button
              key={d.id}
              className="flex w-full flex-wrap items-center gap-3 py-4 text-left hover:bg-muted"
              onClick={() => onNavigate(devicePath(d.id))}
            >
              <Server size={20} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 basis-32 truncate font-medium">{d.name}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="status-dot" data-status={d.status} />
                {agentVersionMismatch(d)
                  ? t(($) => $.devices.versionMismatch)
                  : t(($) => $.common[d.status])}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(($) => $.devices.workspaces, { count: d.snapshot?.workspaces.length ?? 0 })}
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
export function DeviceDetail({
  device,
  onNavigate,
  onAdd,
  onAction,
}: {
  device: Device;
  onNavigate: (path: string) => void;
  onAdd: (device: Device) => void;
  onAction: (action: DeviceAction) => void;
}) {
  const { t, i18n } = useTranslation();

  const [settings, setSettings] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [observation, setObservation] = useState<SessionObservation>();
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [sessionsError, setSessionsError] = useState<unknown>();
  const refreshSessions = useRef<() => void>(() => {});
  const counts: Record<string, number> = {};
  for (const session of observation?.sessions ?? [])
    counts[session.workspaceId] = (counts[session.workspaceId] ?? 0) + 1;
  const oldObservation = device.status !== "online" || sessionsBusy || !!sessionsError;
  useEffect(() => {
    if (device.status !== "online") return;
    let stopped = false;
    let pending = false;
    const abort = new AbortController();
    async function refresh() {
      if (pending || stopped) return;
      pending = true;
      setSessionsBusy(true);
      try {
        const result = await rpc(device.id, "sessions.list", {}, abort.signal);
        if (stopped) return;
        setObservation({ sessions: result.sessions, observedAt: new Date().toISOString() });
        setSessionsError(undefined);
      } catch (error) {
        if (!stopped) setSessionsError(error);
      } finally {
        pending = false;
        if (!stopped) setSessionsBusy(false);
      }
    }
    refreshSessions.current = () => void refresh();
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      refreshSessions.current = () => {};
      setSessionsBusy(false);
    };
  }, [device.id, device.status]);
  return (
    <section className="scroll-area overflow-auto p-5">
      <div className="mb-2 flex items-center gap-3">
        <Server size={23} className="text-muted-foreground" />
        <h1 className="min-w-0 flex-1 break-words text-lg font-semibold">{device.name}</h1>
        <Menu>
          <MenuTrigger
            render={
              <Button
                ref={actionsTrigger}
                variant="ghost"
                size="icon"
                aria-label={t(($) => $.devices.deviceActions)}
              />
            }
          >
            <MoreHorizontal />
          </MenuTrigger>
          <MenuContent>
            <MenuItem disabled={device.status === "revoked"} onClick={() => setUpgrade(true)}>
              <Download />
              {t(($) => $.devices.upgradeAgent)}
            </MenuItem>
            <MenuItem onClick={() => setSettings(true)}>
              <Settings />
              {t(($) => $.terminal.settings)}
            </MenuItem>
            <MenuItem onClick={() => onAction({ type: "rename", device })}>
              <Pencil />
              {t(($) => $.common.rename)}
            </MenuItem>
            <MenuItem
              disabled={device.status === "revoked"}
              onClick={() => onAction({ type: "revoke", device })}
            >
              <Trash2 />
              {t(($) => $.devices.revokeDevice)}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="mb-7 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="status-dot" data-status={device.status} />
          {agentVersionMismatch(device)
            ? t(($) => $.devices.versionMismatch)
            : t(($) => $.common[device.status])}
        </span>
        {device.lastSeenAt && (
          <span>
            {t(($) => $.devices.lastSeen, {
              time: new Date(device.lastSeenAt).toLocaleString(i18n.resolvedLanguage),
            })}
          </span>
        )}
        {device.release && (
          <span>
            {t(($) => $.devices.releaseVersions, {
              agent: device.release.agentVersion ?? t(($) => $.devices.versionUnknown),
              server: device.release.serverVersion,
            })}
          </span>
        )}
      </div>
      {device.release && device.status !== "online" && (
        <div className="mb-5 space-y-1 text-xs text-muted-foreground">
          <p>
            {t(($) => $.devices.versionObserved, {
              time: new Date(device.release.observedAt).toLocaleString(i18n.resolvedLanguage),
            })}
          </p>
          {agentVersionMismatch(device) && (
            <p role="status" className="text-destructive">
              {t(($) => $.devices.matchingReleaseRequired)}
            </p>
          )}
        </div>
      )}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Workspaces{" "}
          <span className="ml-1 text-muted-foreground">
            {(device.snapshot?.workspaces.length ?? 0).toLocaleString(i18n.resolvedLanguage)}
          </span>
        </h2>
        <Button
          variant="outline"
          disabled={device.status !== "online"}
          onClick={() => onAdd(device)}
        >
          <FolderPlus />
          {t(($) => $.common.add)}
        </Button>
      </div>
      <Button
        variant="outline"
        className="mb-4"
        onClick={() => onNavigate(schedulePath({ filter: device.id }))}
      >
        <CalendarClock />
        {t(($) => $.schedules.title)}
      </Button>
      <SessionFinder
        device={device}
        observation={observation}
        error={sessionsError}
        busy={sessionsBusy}
        onRefresh={() => refreshSessions.current()}
        onNavigate={onNavigate}
      />
      <div className="divide-y divide-border border-y border-border">
        {device.snapshot?.workspaces.map((w) => (
          <div key={w.id} className="flex items-center gap-2">
            <button
              className="flex min-w-0 flex-1 items-center gap-3 py-4 text-left hover:bg-muted"
              onClick={() => onNavigate(workspacePath(device.id, w.id))}
            >
              <Folder className="shrink-0 text-primary" size={18} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{w.name}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground" title={w.path}>
                  {w.path}
                </span>
              </span>
              {observation && (
                <span
                  className="ml-auto shrink-0 text-right text-xs text-muted-foreground"
                  title={t(($) => $.devices.runningTerminals)}
                >
                  {t(($) => $.devices.terminals, { count: counts[w.id] ?? 0 })}
                  {oldObservation && (
                    <span className="block">{t(($) => $.devices.previousObservation)}</span>
                  )}
                </span>
              )}
            </button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t(($) => $.common.actionsNamed, { name: w.name })}
                  />
                }
              >
                <MoreHorizontal />
              </MenuTrigger>
              <MenuContent>
                <MenuItem
                  disabled={device.status !== "online"}
                  onClick={() => onAction({ type: "workspace-rename", device, workspace: w })}
                >
                  <Pencil />
                  {t(($) => $.common.rename)}
                </MenuItem>
                <MenuItem
                  disabled={device.status !== "online"}
                  onClick={() => onAction({ type: "workspace-remove", device, workspace: w })}
                >
                  <Trash2 />
                  {t(($) => $.devices.remove)}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        ))}
      </div>
      {settings && <TerminalSettings device={device} onClose={() => setSettings(false)} />}
      {upgrade && (
        <UpgradeDialog
          deviceName={device.name}
          trigger={actionsTrigger}
          onClose={() => setUpgrade(false)}
        />
      )}
    </section>
  );
}
