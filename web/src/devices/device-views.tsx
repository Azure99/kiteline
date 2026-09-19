import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
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
  Globe,
} from "lucide-react";
import type { Device } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { devicePath, workspacePath } from "../lib/navigation";
import type { DeviceAction } from "./device-actions";
import { useEffect, useState } from "react";
import { Dialog } from "../components/ui/dialog";
import { TerminalSettings } from "../terminal/settings";
import { rpc } from "../lib/api";
import { IconButton } from "../components/icon-button";

export function DeviceList({
  devices,
  onNavigate,
  onBind,
}: {
  devices: Device[];
  onNavigate: (path: string) => void;
  onBind: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="scroll-area overflow-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-semibold">{t(($) => $.common.devices)}</h1>
        <Button onClick={() => onBind()}>
          <Plus />
          {t(($) => $.devices.bind)}
        </Button>
      </div>
      {devices.length === 0 ? (
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
                {t(($) => $.common[d.status])}
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
  onPort,
}: {
  device: Device;
  onNavigate: (path: string) => void;
  onAdd: (device: Device) => void;
  onAction: (action: DeviceAction) => void;
  onPort: () => void;
}) {
  const { t, i18n } = useTranslation();

  const [settings, setSettings] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [countError, setCountError] = useState<unknown>();
  useEffect(() => {
    if (device.status !== "online") return;
    let stopped = false;
    let revision = 0;
    const abort = new AbortController();
    async function refresh() {
      const current = ++revision;
      try {
        const result = await rpc(device.id, "sessions.list", {}, abort.signal);
        if (stopped || current !== revision) return;
        const next: Record<string, number> = {};
        for (const session of result.sessions)
          next[session.workspaceId] = (next[session.workspaceId] ?? 0) + 1;
        setCounts(next);
        setCountError("");
      } catch (error) {
        if (!stopped && current === revision) setCountError(error);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      stopped = true;
      abort.abort();
      clearInterval(timer);
    };
  }, [device.id, device.status]);
  return (
    <section className="scroll-area overflow-auto p-5">
      <div className="mb-2 flex items-center gap-3">
        <Server size={23} className="text-muted-foreground" />
        <h1 className="min-w-0 flex-1 break-all text-lg font-semibold">{device.name}</h1>
        {device.status !== "revoked" && (
          <IconButton label={t(($) => $.devices.devicePort)} onClick={onPort}>
            <Globe />
          </IconButton>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon" aria-label={t(($) => $.devices.deviceActions)} />
            }
          >
            <MoreHorizontal />
          </MenuTrigger>
          <MenuContent>
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
          {t(($) => $.common[device.status])}
        </span>
        {device.lastSeenAt && (
          <span>
            {t(($) => $.devices.lastSeen, {
              time: new Date(device.lastSeenAt).toLocaleString(i18n.resolvedLanguage),
            })}
          </span>
        )}
      </div>
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
              {device.status === "online" && !!counts[w.id] && (
                <span
                  className="ml-auto shrink-0 text-xs text-muted-foreground"
                  title={t(($) => $.devices.runningTerminals)}
                >
                  {t(($) => $.devices.terminals, { count: counts[w.id]! })}
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
      {!!countError && (
        <div role="alert" className="mt-2 text-sm text-destructive">
          <ErrorNotice error={countError} />
        </div>
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        {settings && <TerminalSettings device={device} />}
      </Dialog>
    </section>
  );
}
