import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Maximize2, PanelBottom, Plus, RefreshCw, X } from "lucide-react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";
import { TerminalView, type TerminalActions } from "./terminal-view";
import { TerminalSettings } from "./settings";
import { navigate, useRoute, workspacePath } from "../lib/navigation";
import { useMobile } from "../lib/use-mobile";
import { useSessions } from "./use-sessions";
import {
  currentGroup,
  emptyLayout,
  selectSession,
  closeSession,
  moveSession,
  retainSessions,
  type TerminalLayout,
} from "./groups";
import { SplitPanes } from "./split-panes";
import { SessionMenu, type SessionCommand } from "./session-menu";
import type { DisplayState } from "./display";
import { SessionPicker, NewSessionButtons } from "./session-controls";
import { SessionDialog, type SessionAction } from "./session-dialog";
import { GroupTabs, useTerminalDrag } from "./group-tabs";

export function WorkspaceTerminal({
  device,
  workspace,
  visible,
  layouts,
  children,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  layouts: Map<string, TerminalLayout>;
  children: ReactNode;
}) {
  const key = `${device.id}:${workspace.id}`;
  const [layout, setLayout] = useState(() => layouts.get(key) ?? emptyLayout());
  const remote = useSessions(device, workspace.id);
  const mobile = useMobile();
  const route = useRoute();
  const routeSession = route.query.get("session");
  const lastRouteSession = useRef<string | null | undefined>(undefined);
  const displays = useRef(new Map<string, TerminalActions>());
  const dockActions = useRef<TerminalActions>(null);
  const [statuses, setStatuses] = useState<Record<string, DisplayState["status"]>>({});
  const [settings, setSettings] = useState(false);
  const [action, setAction] = useState<SessionAction>();
  const group = currentGroup(layout);
  const selected = group?.active;
  const sessions = remote.sessions;
  const { setError } = remote;
  const find = (id?: string) => sessions.find((session) => session.id === id);
  const members = group?.members.filter((id) => !!find(id) || displays.current.has(id)) ?? [];
  const dockId =
    layout.dock && (find(layout.dock) || dockActions.current) ? layout.dock : undefined;
  const enabled = device.status === "online" && !remote.busy;
  useEffect(() => {
    layouts.set(key, layout);
  }, [key, layout, layouts]);
  useEffect(() => {
    if (!remote.loaded) return;
    const kept = new Set([...sessions.map((session) => session.id), ...displays.current.keys()]);
    const dockKept = new Set(sessions.map((session) => session.id));
    if (dockId && dockActions.current) dockKept.add(dockId);
    setLayout((old) => retainSessions(old, kept, dockKept));
  }, [sessions, remote.loaded, layout, mobile, dockId]);
  useEffect(() => {
    if (!remote.loaded || lastRouteSession.current === routeSession) return;
    const previous = lastRouteSession.current;
    lastRouteSession.current = routeSession;
    if (routeSession) {
      if (
        sessions.some((session) => session.id === routeSession) ||
        displays.current.has(routeSession)
      )
        setLayout((old) => selectSession(old, routeSession));
      else setError("终端不存在或已结束");
    } else if (previous !== undefined) setLayout((old) => ({ ...old, current: undefined }));
  }, [routeSession, remote.loaded, sessions, setError]);
  const register = useCallback((id: string, value: TerminalActions | null) => {
    if (value) displays.current.set(id, value);
    else {
      displays.current.delete(id);
      setStatuses((old) => {
        if (!(id in old)) return old;
        const next = { ...old };
        delete next[id];
        return next;
      });
    }
  }, []);
  const status = useCallback((id: string, value: DisplayState["status"]) => {
    setStatuses((old) => (old[id] === value ? old : { ...old, [id]: value }));
  }, []);
  function applyMain(next: TerminalLayout, tool = route.tool, replace = false) {
    setLayout(next);
    const id = currentGroup(next)?.active;
    const query = new URLSearchParams(location.search);
    if (id) query.set("session", id);
    else query.delete("session");
    lastRouteSession.current = id ?? null;
    const path = workspacePath(device.id, workspace.id, tool) + (query.size ? `?${query}` : "");
    if (path !== location.pathname + location.search) navigate(path, replace);
  }
  function choose(id: string, dock = false) {
    if (dock) setLayout((old) => ({ ...old, dock: id, dockOpen: true }));
    else applyMain(selectSession(layout, id));
  }
  function focus(id: string) {
    if (selected !== id) applyMain(selectSession(layout, id), route.tool, true);
  }
  function close(id: string, dock = false) {
    if (dock) setLayout((old) => ({ ...old, dock: undefined }));
    else applyMain(closeSession(layout, id));
  }
  function move(id: string, target?: string, before?: string) {
    applyMain(moveSession(layout, id, target, before));
  }
  const drag = useTerminalDrag(!mobile, move);
  function patchGroup(change: Partial<NonNullable<typeof group>>) {
    if (!group) return;
    setLayout((old) => ({
      ...old,
      groups: old.groups.map((item) => (item.id === group.id ? { ...item, ...change } : item)),
    }));
  }
  async function create(dock = false, split = false, shortcutId?: string) {
    const target = split ? group?.id : undefined;
    const session = await remote.create(shortcutId);
    if (!session) return;
    setLayout((old) => {
      const next =
        target && old.groups.some((item) => item.id === target)
          ? moveSession(old, session.id, target)
          : selectSession(old, session.id);
      if (dock) return { ...next, current: old.current, dock: session.id, dockOpen: true };
      return { ...next, dock: old.dock ?? session.id };
    });
    if (!dock) {
      const query = new URLSearchParams(location.search);
      query.set("session", session.id);
      lastRouteSession.current = session.id;
      navigate(location.pathname + `?${query}`);
    }
  }
  function command(kind: SessionCommand, id: string, dock = false) {
    const display = dock ? dockActions.current : displays.current.get(id);
    if (kind === "redisplay") display?.redisplay();
    else if (kind === "redraw") display?.redraw();
    else if (kind === "larger" || kind === "smaller") display?.fontSize(kind === "larger" ? 1 : -1);
    else if (kind === "close") close(id, dock);
    else {
      const session = find(id);
      if (!session) return;
      setAction({ kind, session });
    }
  }
  function menu(id?: string, dock = false, label?: string) {
    return (
      <SessionMenu
        id={id}
        session={find(id)}
        layout={layout}
        dock={dock}
        label={label}
        disabled={!enabled}
        onCommand={(kind, value) => command(kind, value, dock)}
        onMove={move}
        onSplit={() => void create(false, true)}
        onDirection={(direction) => patchGroup({ direction, maximized: false })}
        onSettings={() => setSettings(true)}
      />
    );
  }
  function picker(dock = false) {
    return (
      <SessionPicker
        sessions={sessions}
        selected={dock ? dockId : selected}
        dock={dock}
        uncertain={remote.uncertainCreate}
        onSelect={(id) => choose(id, dock)}
      />
    );
  }
  function newButtons(dock = false) {
    return (
      <NewSessionButtons
        dock={dock}
        disabled={!enabled}
        shortcuts={device.snapshot?.shortcuts ?? []}
        onCreate={(shortcut) => void create(dock, false, shortcut)}
      />
    );
  }
  return (
    <>
      {remote.error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 bg-red-50 px-3 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">{remote.error}</span>
          <IconButton label="关闭提示" onClick={remote.clearError}>
            <X />
          </IconButton>
        </div>
      )}
      <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2">
          {picker()}
          <span className="flex-1" />
          {newButtons()}
          <IconButton
            label="刷新会话"
            disabled={device.status !== "online"}
            onClick={() => void remote.refresh()}
          >
            <RefreshCw />
          </IconButton>
          {selected && (
            <IconButton label="关闭显示" onClick={() => close(selected)}>
              <X />
            </IconButton>
          )}
          {menu(selected)}
        </div>
        <GroupTabs
          layout={layout}
          sessions={sessions}
          mobile={mobile}
          drag={drag}
          onSelect={choose}
          ended={new Set(Object.keys(statuses).filter((id) => statuses[id] === "ended"))}
        />
        {group && members.length ? (
          <SplitPanes
            deviceId={device.id}
            workspaceId={workspace.id}
            group={group}
            members={members}
            sessions={sessions}
            mobile={mobile}
            visible={visible}
            onSizes={(sizes) => patchGroup({ sizes })}
            events={{
              actions: register,
              status,
              focus,
              close,
              maximize: () => patchGroup({ maximized: !group.maximized }),
              menu: (id) => menu(id, false, `${find(id)?.name ?? "终端"} 操作`),
              dragStart: drag.start,
              dragEnd: drag.end,
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Button variant="outline" disabled={!enabled} onClick={() => void create()}>
              <Plus />
              新建终端
            </Button>
          </div>
        )}
      </div>
      <div className={visible ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <div className="flex min-h-9 shrink-0 items-center justify-end border-b border-border px-2 max-[959px]:hidden">
          <IconButton
            label={layout.dockOpen ? "收起配套终端" : "展开配套终端"}
            onClick={() =>
              setLayout((old) => ({ ...old, dockOpen: !old.dockOpen, dock: old.dock ?? selected }))
            }
          >
            <PanelBottom />
          </IconButton>
        </div>
        <Group
          id={`companion-${workspace.id}-${layout.dockOpen && !mobile ? "open" : "closed"}`}
          orientation="vertical"
          className="min-h-0 flex-1"
          onLayoutChanged={(sizes, meta) => {
            if (meta.isUserInteraction) setLayout((old) => ({ ...old, dockSize: sizes.dock! }));
          }}
        >
          <Panel
            id="tool"
            minSize={mobile || !layout.dockOpen ? 0 : 160}
            className="flex h-full min-h-0 flex-col"
          >
            {children}
          </Panel>
          {layout.dockOpen && !mobile && (
            <>
              <Separator className="split-divider" aria-label="调整配套终端高度" />
              <Panel
                id="dock"
                minSize={170}
                defaultSize={`${layout.dockSize}%`}
                className="flex h-full min-h-0 flex-col"
              >
                <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2">
                  {picker(true)}
                  <span className="flex-1" />
                  {newButtons(true)}
                  {dockId && (
                    <>
                      <IconButton
                        label="在 Terminal 展开"
                        disabled={!find(dockId) && !displays.current.has(dockId)}
                        onClick={() => applyMain(selectSession(layout, dockId), "terminal")}
                      >
                        <Maximize2 />
                      </IconButton>
                      <IconButton label="关闭配套显示" onClick={() => close(dockId, true)}>
                        <X />
                      </IconButton>
                    </>
                  )}
                  {menu(dockId, true)}
                </div>
                {dockId ? (
                  <TerminalView
                    key={dockId}
                    ref={dockActions}
                    deviceId={device.id}
                    workspaceId={workspace.id}
                    sessionId={dockId}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    选择终端会话
                  </div>
                )}
              </Panel>
            </>
          )}
        </Group>
      </div>
      {action && (
        <SessionDialog
          key={`${action.kind}:${action.session.id}`}
          action={action}
          busy={remote.busy}
          onClose={() => setAction(undefined)}
          onChange={remote.change}
        />
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        {settings && <TerminalSettings device={device} />}
      </Dialog>
    </>
  );
}
