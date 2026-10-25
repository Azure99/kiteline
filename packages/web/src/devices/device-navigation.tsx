import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Circle, Globe, Plus, Search, Server, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Device } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { ReportContent, type ReceivedReport } from "../terminal/reports";
import { devicePath, workspaceDestination, type WorkspaceTool } from "../lib/navigation";
import { isDirty, useDrafts, type DraftStore } from "../files/drafts";
import { useMobile } from "../lib/use-mobile";
import type { DeviceAction } from "./device-actions";
import { DeviceMenu } from "./device-menu";
import { WorkspaceMenu } from "./workspace-menu";

export function DeviceNavigation({
  devices,
  deviceId,
  workspaceId,
  tool,
  drafts,
  reports,
  onReport,
  onNavigate,
  onBind,
  onPort,
  onAdd,
  onAction,
}: {
  devices: Device[];
  deviceId?: string;
  workspaceId?: string;
  tool?: WorkspaceTool;
  drafts: DraftStore;
  reports: ReceivedReport[];
  onReport: (report: ReceivedReport) => void;
  onNavigate: (path: string, options?: { keyboard?: boolean }) => void;
  onBind: () => void;
  onPort: (deviceId: string) => void;
  onAdd: (device: Device) => void;
  onAction: (action: DeviceAction) => void;
}) {
  const { t } = useTranslation();
  const mobile = useMobile();
  const openDrafts = useDrafts(drafts);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const visibleCollapsed = query.trim() ? [] : collapsed;
  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
    searchButton.current?.focus();
  }
  const filter = query.trim().toLowerCase();
  const matches = devices
    .map((device) => ({
      device,
      workspaces: (device.snapshot?.workspaces ?? []).filter(
        (workspace) =>
          workspace.name.toLowerCase().includes(filter) ||
          workspace.path.toLowerCase().includes(filter),
      ),
    }))
    .filter(({ workspaces }) => !filter || workspaces.length > 0);
  const matchingWorkspaces = matches.flatMap(({ device, workspaces }) =>
    workspaces.map((workspace) => ({ device, workspace })),
  );
  return (
    <nav aria-label={t(($) => $.shell.deviceWorkspaces)} className="space-y-1 p-2">
      <div className="flex items-center justify-between gap-1 px-1">
        <button
          className="flex-1 text-left text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => onNavigate("/devices", { keyboard: event.detail === 0 })}
        >
          {t(($) => $.shell.deviceWorkspaces)}
        </button>
        <IconButton
          label={t(($) => $.devices.bind)}
          onClick={() => {
            onBind();
          }}
        >
          <Plus />
        </IconButton>
        <IconButton
          ref={searchButton}
          label={t(($) =>
            searchOpen ? $.devices.closeWorkspaceFilter : $.devices.filterWorkspaces,
          )}
          aria-expanded={searchOpen}
          aria-controls="workspace-filter"
          onClick={() => {
            if (searchOpen) closeSearch();
            else setSearchOpen(true);
          }}
        >
          <Search />
        </IconButton>
      </div>
      {searchOpen && (
        <div className="flex items-center gap-1 pb-2">
          <Input
            id="workspace-filter"
            ref={input}
            autoFocus
            value={query}
            aria-label={t(($) => $.devices.filterWorkspaces)}
            placeholder={t(($) => $.devices.filterWorkspacesHint)}
            className="min-w-0 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeSearch();
              }
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                filter &&
                matchingWorkspaces.length === 1
              ) {
                event.preventDefault();
                const { device, workspace } = matchingWorkspaces[0]!;
                onNavigate(
                  workspaceDestination(
                    { deviceId: device.id, workspaceId: workspace.id },
                    tool ?? "terminal",
                  ),
                  { keyboard: true },
                );
              }
            }}
          />
          {query && (
            <IconButton
              label={t(($) => $.devices.clearWorkspaceFilter)}
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
            >
              <X />
            </IconButton>
          )}
        </div>
      )}
      {filter && matches.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">
          {t(($) => $.devices.noMatchingWorkspaces)}
        </p>
      )}
      {matches.map(({ device: d, workspaces }) => (
        <div key={d.id}>
          <div
            className={`flex items-center rounded ${deviceId === d.id && !tool ? "bg-primary-soft" : ""}`}
          >
            <IconButton
              label={t(
                ($) =>
                  visibleCollapsed.includes(d.id) ? $.common.expandNamed : $.common.collapseNamed,
                {
                  name: d.name,
                },
              )}
              className="size-6 max-desk:w-8"
              aria-expanded={!visibleCollapsed.includes(d.id)}
              disabled={!!filter}
              onClick={() =>
                setCollapsed((previous) =>
                  previous.includes(d.id)
                    ? previous.filter((id) => id !== d.id)
                    : [...previous, d.id],
                )
              }
            >
              {visibleCollapsed.includes(d.id) ? <ChevronRight /> : <ChevronDown />}
            </IconButton>
            <DeviceMenu
              device={d}
              onNavigate={onNavigate}
              onAdd={onAdd}
              onAction={onAction}
              onPort={onPort}
            >
              <button
                className={`flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring max-desk:min-h-11 max-desk:text-sm ${deviceId === d.id && !tool ? "" : "hover:bg-muted"}`}
                onClick={(event) => onNavigate(devicePath(d.id), { keyboard: event.detail === 0 })}
              >
                <Server size={15} className="shrink-0 text-muted-foreground" />
                <span
                  className="min-w-0 flex-1 truncate max-desk:whitespace-normal max-desk:break-all"
                  title={d.name}
                >
                  {d.name}
                </span>
                <span
                  className="status-dot"
                  data-status={d.status}
                  aria-label={t(($) => $.common[d.status])}
                />
              </button>
            </DeviceMenu>
            <IconButton
              label={t(($) => $.shell.openDevicePort, { name: d.name })}
              onClick={() => onPort(d.id)}
            >
              <Globe />
            </IconButton>
          </div>
          {!visibleCollapsed.includes(d.id) &&
            workspaces.map((w) => {
              const sources = reports.filter(
                (report) => report.deviceId === d.id && report.workspaceId === w.id,
              );
              const path = workspaceDestination(
                { deviceId: d.id, workspaceId: w.id },
                tool ?? "terminal",
              );
              const open = (keyboard = false) => onNavigate(path, { keyboard });
              return (
                <div key={w.id}>
                  <div className="group flex items-center">
                    <WorkspaceMenu
                      navigation
                      device={d}
                      workspace={w}
                      onOpen={() => open()}
                      onAction={onAction}
                    >
                      <button
                        aria-current={
                          deviceId === d.id && workspaceId === w.id ? "page" : undefined
                        }
                        className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded border-l-2 pl-3 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-desk:min-h-11 ${deviceId === d.id && workspaceId === w.id ? "border-primary bg-primary-soft text-primary" : "border-transparent hover:bg-muted"}`}
                        onClick={(event) => open(event.detail === 0)}
                      >
                        <span className="min-w-0 flex-1" title={w.name}>
                          <span className="block truncate">{w.name}</span>
                          {filter && w.path.toLowerCase().includes(filter) && (
                            <span
                              className="block whitespace-normal break-all text-xs text-muted-foreground"
                              title={w.path}
                            >
                              {w.path}
                            </span>
                          )}
                        </span>
                        {openDrafts.some(
                          (draft) =>
                            draft.deviceId === d.id && draft.workspaceId === w.id && isDirty(draft),
                        ) && (
                          <Circle
                            size={7}
                            fill="currentColor"
                            aria-label={t(($) => $.files.unsaved)}
                          />
                        )}
                      </button>
                    </WorkspaceMenu>

                    {!mobile && sources.length > 0 && (
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${w.name} · ${t(($) => $.reports.count, { count: sources.length })}`}
                            />
                          }
                        >
                          <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                            {sources.length}
                          </span>
                        </MenuTrigger>
                        <MenuContent>
                          {sources.map((report) => (
                            <MenuItem
                              key={report.sessionId}
                              aria-label={t(($) => $.reports.returnTo, { name: report.name })}
                              onClick={() => onReport(report)}
                            >
                              <ReportContent report={report} />
                            </MenuItem>
                          ))}
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                  {mobile &&
                    sources.map((report) => (
                      <button
                        key={report.sessionId}
                        className="ml-8 block w-[calc(100%_-_2rem)] rounded border-l-2 border-primary px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={t(($) => $.reports.returnTo, { name: report.name })}
                        onClick={() => onReport(report)}
                      >
                        <ReportContent report={report} />
                      </button>
                    ))}
                </div>
              );
            })}
        </div>
      ))}
    </nav>
  );
}
