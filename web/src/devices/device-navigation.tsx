import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder, Plus, Server } from "lucide-react";
import { useState } from "react";
import type { Device } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { devicePath, workspacePath } from "../lib/navigation";

export function DeviceNavigation({
  devices,
  deviceId,
  workspaceId,
  tool,
  onNavigate,
  onBind,
}: {
  devices: Device[];
  deviceId?: string;
  workspaceId?: string;
  tool?: string;
  onNavigate: (path: string) => void;
  onBind: () => void;
}) {
  const { t } = useTranslation();

  const [collapsed, setCollapsed] = useState<string[]>([]);
  return (
    <nav aria-label={t(($) => $.shell.deviceWorkspaces)} className="space-y-1 p-2">
      <div className="flex items-center justify-between px-2 py-2">
        <button
          className="text-xs font-medium text-muted-foreground"
          onClick={() => onNavigate("/devices")}
        >
          {t(($) => $.common.devices)}
        </button>
        <IconButton
          label={t(($) => $.devices.bind)}
          onClick={() => {
            onBind();
          }}
        >
          <Plus />
        </IconButton>
      </div>
      {devices.map((d) => (
        <div key={d.id}>
          <div className="flex items-center">
            <button
              className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted max-[959px]:min-h-11 ${deviceId === d.id ? "bg-primary-soft" : ""}`}
              onClick={() => onNavigate(devicePath(d.id))}
            >
              <span className="status-dot" data-status={d.status} />
              <Server size={15} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={d.name}>
                {d.name}
              </span>
            </button>
            <IconButton
              label={t(
                ($) => (collapsed.includes(d.id) ? $.common.expandNamed : $.common.collapseNamed),
                { name: d.name },
              )}
              aria-expanded={!collapsed.includes(d.id)}
              onClick={() =>
                setCollapsed((previous) =>
                  previous.includes(d.id)
                    ? previous.filter((id) => id !== d.id)
                    : [...previous, d.id],
                )
              }
            >
              {collapsed.includes(d.id) ? <ChevronRight /> : <ChevronDown />}
            </IconButton>
          </div>
          {!collapsed.includes(d.id) &&
            d.snapshot?.workspaces.map((w) => (
              <button
                key={w.id}
                className={`flex min-h-9 w-full items-center gap-2 rounded py-1.5 pl-8 pr-2 text-left text-xs hover:bg-muted max-[959px]:min-h-11 max-[959px]:text-sm ${deviceId === d.id && workspaceId === w.id ? "bg-primary-soft text-primary" : "text-muted-foreground"}`}
                onClick={() => onNavigate(workspacePath(d.id, w.id, tool))}
              >
                <Folder size={14} className="shrink-0" />
                <span className="min-w-0 truncate" title={w.path}>
                  {w.name}
                </span>
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}
