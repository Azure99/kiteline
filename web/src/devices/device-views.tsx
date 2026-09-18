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
import type { Device, Session } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { devicePath, workspacePath } from "../lib/navigation";
import type { DeviceAction } from "./device-actions";
import { useEffect, useState } from "react";
import { Dialog } from "../components/ui/dialog";
import { TerminalSettings } from "../terminal/settings";
import { rpc, errorMessage } from "../lib/api";
import { IconButton } from "../components/icon-button";

export const statusNames = { online: "在线", offline: "离线", revoked: "已撤销" };

export function DeviceList({
  devices,
  onNavigate,
  onBind,
}: {
  devices: Device[];
  onNavigate: (path: string) => void;
  onBind: () => void;
}) {
  return (
    <section className="scroll-area overflow-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-semibold">设备</h1>
        <Button onClick={() => onBind()}>
          <Plus />
          绑定设备
        </Button>
      </div>
      {devices.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground">
          <Monitor size={30} className="mx-auto mb-3" />
          <p>尚未绑定设备</p>
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
                {statusNames[d.status]}
              </span>
              <span className="text-xs text-muted-foreground">
                {d.snapshot?.workspaces.length ?? 0} workspace
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
  const [settings, setSettings] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [countError, setCountError] = useState("");
  useEffect(() => {
    if (device.status !== "online") return;
    let stopped = false;
    let revision = 0;
    const abort = new AbortController();
    async function refresh() {
      const current = ++revision;
      try {
        const result = await rpc<{ sessions: Session[] }>(
          device.id,
          "sessions.list",
          {},
          abort.signal,
        );
        if (stopped || current !== revision) return;
        const next: Record<string, number> = {};
        for (const session of result.sessions)
          next[session.workspaceId] = (next[session.workspaceId] ?? 0) + 1;
        setCounts(next);
        setCountError("");
      } catch (error) {
        if (!stopped && current === revision) setCountError(errorMessage(error));
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
          <IconButton label="访问此设备端口" onClick={onPort}>
            <Globe />
          </IconButton>
        )}
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="设备操作" />}>
            <MoreHorizontal />
          </MenuTrigger>
          <MenuContent>
            <MenuItem onClick={() => setSettings(true)}>
              <Settings />
              终端设置
            </MenuItem>
            <MenuItem onClick={() => onAction({ type: "rename", device })}>
              <Pencil />
              重命名
            </MenuItem>
            <MenuItem
              disabled={device.status === "revoked"}
              onClick={() => onAction({ type: "revoke", device })}
            >
              <Trash2 />
              撤销设备
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="mb-7 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="status-dot" data-status={device.status} />
          {statusNames[device.status]}
        </span>
        {device.lastSeenAt && <span>最近连接 {new Date(device.lastSeenAt).toLocaleString()}</span>}
      </div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Workspaces{" "}
          <span className="ml-1 text-muted-foreground">
            {device.snapshot?.workspaces.length ?? 0}
          </span>
        </h2>
        <Button
          variant="outline"
          disabled={device.status !== "online"}
          onClick={() => onAdd(device)}
        >
          <FolderPlus />
          添加
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
                  title="运行或创建中的终端"
                >
                  {counts[w.id]} 终端
                </span>
              )}
            </button>
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon" aria-label={`${w.name} 操作`} />}
              >
                <MoreHorizontal />
              </MenuTrigger>
              <MenuContent>
                <MenuItem
                  disabled={device.status !== "online"}
                  onClick={() => onAction({ type: "workspace-rename", device, workspace: w })}
                >
                  <Pencil />
                  重命名
                </MenuItem>
                <MenuItem
                  disabled={device.status !== "online"}
                  onClick={() => onAction({ type: "workspace-remove", device, workspace: w })}
                >
                  <Trash2 />
                  移除
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        ))}
      </div>
      {countError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {countError}
        </p>
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        {settings && <TerminalSettings device={device} />}
      </Dialog>
    </section>
  );
}
