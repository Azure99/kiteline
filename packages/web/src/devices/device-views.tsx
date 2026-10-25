import { useTranslation } from "react-i18next";
import { agentVersionMismatch } from "../lib/release";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Monitor,
  Server,
  FileText,
  GitBranch,
  Terminal,
  CalendarClock,
} from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { devicePath, workspacePath, tasksPath } from "../lib/navigation";
import type { DeviceActions } from "./device-actions";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/api";
import type { RecentWorkspace } from "./recent-workspaces";
import { SessionFinder, type SessionObservation } from "./session-finder";
import { DeviceMenu } from "./device-menu";
import { WorkspaceMenu } from "./workspace-menu";

const sessionsRefreshIntervalMs = 15_000;
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
    const device = devices.find((item) => item.id === entry.deviceId);
    const workspace = device?.snapshot?.workspaces.find((item) => item.id === entry.workspaceId);
    return device && workspace ? [{ entry, device, workspace }] : [];
  });

  return (
    <section className="scroll-area overflow-auto p-5">
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
          <p className="mx-auto mt-2 max-w-sm text-sm">{t(($) => $.devices.noDevicesHint)}</p>
          <Button className="mt-4" onClick={onBind}>
            {t(($) => $.devices.bind)}
          </Button>
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
export function DeviceDetail({ device, actions }: { device: Device; actions: DeviceActions }) {
  const { t, i18n } = useTranslation();

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
    const timer = setInterval(() => void refresh(), sessionsRefreshIntervalMs);
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
        <DeviceMenu device={device} actions={actions} />
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
      <Button
        variant="outline"
        className="mb-4"
        onClick={() => actions.navigate(tasksPath({ filter: device.id }))}
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
        onNavigate={actions.navigate}
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {t(($) => $.devices.workspaces, { count: device.snapshot?.workspaces.length ?? 0 })}
        </h2>
        <Button
          variant="outline"
          disabled={device.status !== "online"}
          onClick={() => actions.addWorkspace(device)}
        >
          <FolderPlus />
          {t(($) => $.devices.addWorkspace)}
        </Button>
      </div>
      {device.snapshot?.workspaces.length === 0 && (
        <p className="mb-4 text-sm text-muted-foreground">{t(($) => $.devices.noWorkspacesHint)}</p>
      )}
      <div className="divide-y divide-border border-y border-border">
        {device.snapshot?.workspaces.map((w) => (
          <div key={w.id} className="group flex items-center gap-2">
            <WorkspaceMenu
              device={device}
              workspace={w}
              onOpen={() => actions.navigate(workspacePath(device.id, w.id))}
              onAction={actions.openAction}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-3 py-4 text-left hover:bg-muted"
                onClick={() => actions.navigate(workspacePath(device.id, w.id))}
              >
                <Folder className="shrink-0 text-primary" size={18} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  <span
                    className="mt-1 block truncate text-xs text-muted-foreground"
                    title={w.path}
                  >
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
            </WorkspaceMenu>
          </div>
        ))}
      </div>
    </section>
  );
}
