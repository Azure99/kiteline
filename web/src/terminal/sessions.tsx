import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { ErrorNotice } from "../components/error-notice";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, type GroupImperativeHandle } from "react-resizable-panels";
import {
  Folder,
  GitBranch,
  Terminal,
  Maximize2,
  PanelBottom,
  Minimize2,
  Columns2,
  Fullscreen,
  X,
  Minimize,
} from "lucide-react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { WatchStatus } from "../components/watch-status";
import { ToolLayout } from "../components/tool-layout";
import { TerminalView, type TerminalActions } from "./terminal-view";
import { TerminalSettings } from "./settings";
import { navigateWorkspace, updateWorkspaceQuery, useRoute } from "../lib/navigation";
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
import { SessionPicker, NewSessionButtons } from "./session-controls";
import { SessionDialog, type SessionAction } from "./session-dialog";
import { GroupTabs, useTerminalDrag } from "./group-tabs";

export function WorkspaceTerminal({
  device,
  workspace,
  visible,
  layouts,
  focusMode,
  onEnterFocus,
  onExitFocus,
  children,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  layouts: Map<string, TerminalLayout>;
  focusMode: boolean;
  onEnterFocus(): void;
  onExitFocus(): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  const key = `${device.id}:${workspace.id}`;
  const [layout, setLayout] = useState(() => layouts.get(key) ?? emptyLayout());
  const remote = useSessions(device, workspace.id);
  const mobile = useMobile();
  const route = useRoute();
  const routeSession = route.query.session ?? null;
  const lastRouteSession = useRef<string | null | undefined>(undefined);
  const lastTool = useRef<string | undefined>(undefined);
  const displays = useRef(new Map<string, TerminalActions>());
  const names = useRef(new Map<string, string>());
  const dockActions = useRef(new Map<string, TerminalActions>());
  const [opened, setOpened] = useState(() => ({
    main: new Set<string>(),
    dock: new Set<string>(),
  }));
  const dockPanels = useRef<GroupImperativeHandle>(null);
  const [settings, setSettings] = useState(false);
  const [action, setAction] = useState<SessionAction>();
  const group = currentGroup(layout);
  const selected = group?.active;
  const sessions = remote.sessions;
  const { setError } = remote;
  const find = (id?: string) => sessions.find((session) => session.id === id);
  const groups = layout.groups
    .map((item) => ({
      ...item,
      members: item.members.filter((id) => !!find(id) || opened.main.has(id)),
    }))
    .filter((item) => item.members.length);
  const members = groups.find((item) => item.id === group?.id)?.members ?? [];
  const dockId =
    layout.dock && (find(layout.dock) || opened.dock.has(layout.dock)) ? layout.dock : undefined;
  const dockExpanded = layout.dockOpen && !mobile;
  const visibleMembers = visible
    ? members.filter((id) => (!mobile && !group?.maximized) || id === selected).join(",")
    : "";
  useLayoutEffect(() => {
    const main = visibleMembers ? visibleMembers.split(",") : [];
    const dock = !visible && dockExpanded && dockId ? [dockId] : [];
    setOpened((old) =>
      main.every((id) => old.main.has(id)) && dock.every((id) => old.dock.has(id))
        ? old
        : {
            main: new Set([...old.main, ...main]),
            dock: new Set([...old.dock, ...dock]),
          },
    );
  }, [visibleMembers, visible, dockExpanded, dockId]);
  useLayoutEffect(() => {
    if (visible) return;
    const size = dockExpanded ? layout.dockSize : 0;
    const frame = requestAnimationFrame(() =>
      dockPanels.current?.setLayout({ tool: 100 - size, dock: size }),
    );
    return () => cancelAnimationFrame(frame);
  }, [visible, dockExpanded, layout.dockSize]);
  const enabled = device.status === "online" && !remote.busy;
  const split = !mobile && members.length > 1 && !group?.maximized;
  const multipleGroups = !mobile && layout.groups.length > 1;
  function name(id: string) {
    return find(id)?.name ?? names.current.get(id) ?? t(($) => $.terminal.ended);
  }
  useEffect(() => {
    for (const session of sessions) names.current.set(session.id, session.name);
    for (const id of names.current.keys())
      if (
        !sessions.some((session) => session.id === id) &&
        !opened.main.has(id) &&
        !opened.dock.has(id)
      )
        names.current.delete(id);
  }, [sessions, opened]);
  useEffect(() => {
    layouts.set(key, layout);
  }, [key, layout, layouts]);
  useEffect(() => {
    if (!remote.loaded) return;
    const kept = new Set([...sessions.map((session) => session.id), ...opened.main]);
    const dockKept = new Set([...sessions.map((session) => session.id), ...opened.dock]);
    setLayout((old) => retainSessions(old, kept, dockKept));
  }, [sessions, remote.loaded, opened]);
  useEffect(() => {
    if (!remote.loaded) return;
    const returning = route.tool === "terminal" && lastTool.current !== "terminal";
    lastTool.current = route.tool;
    if (returning && !routeSession && selected) {
      lastRouteSession.current = selected;
      updateWorkspaceQuery(
        { deviceId: device.id, workspaceId: workspace.id },
        { session: selected },
        true,
      );
      return;
    }
    if (lastRouteSession.current === routeSession) return;
    const previous = lastRouteSession.current;
    lastRouteSession.current = routeSession;
    if (routeSession) {
      if (sessions.some((session) => session.id === routeSession) || opened.main.has(routeSession))
        setLayout((old) => selectSession(old, routeSession));
      else setError(new ApiError("not_found", "The terminal does not exist or has ended"));
    } else if (route.tool === "terminal" && previous !== undefined)
      setLayout((old) => ({ ...old, current: undefined }));
  }, [
    routeSession,
    route.tool,
    selected,
    remote.loaded,
    sessions,
    setError,
    device.id,
    workspace.id,
    opened.main,
  ]);
  const register = useCallback((id: string, value: TerminalActions | null) => {
    if (value) displays.current.set(id, value);
    else displays.current.delete(id);
  }, []);
  function applyMain(next: TerminalLayout, tool = route.tool, replace = false) {
    setLayout(next);
    const id = currentGroup(next)?.active;
    lastRouteSession.current = id ?? null;
    navigateWorkspace(
      { deviceId: device.id, workspaceId: workspace.id },
      tool ?? "terminal",
      { session: id },
      replace,
    );
  }
  function choose(id: string, dock = false) {
    if (!find(id) && !(dock ? opened.dock.has(id) : opened.main.has(id))) return;
    if (dock) setLayout((old) => ({ ...old, dock: id, dockOpen: true }));
    else applyMain(selectSession(layout, id));
  }
  function focus(id: string) {
    if (selected !== id) applyMain(selectSession(layout, id), route.tool, true);
  }
  function close(id: string, dock = false) {
    setOpened((old) => {
      const region = dock ? "dock" : "main";
      const next = new Set(old[region]);
      next.delete(id);
      return { ...old, [region]: next };
    });
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
      if (dock) return { ...old, dock: session.id, dockOpen: true };
      const next =
        target && old.groups.some((item) => item.id === target)
          ? moveSession(old, session.id, target)
          : selectSession(old, session.id);
      return { ...next, dock: old.dock ?? session.id };
    });
    if (!dock) {
      lastRouteSession.current = session.id;
      updateWorkspaceQuery(
        { deviceId: device.id, workspaceId: workspace.id },
        { session: session.id },
      );
    }
  }
  function command(kind: SessionCommand, id: string, dock = false) {
    const display = (dock ? dockActions : displays).current.get(id);
    if (kind === "redraw") display?.redraw();
    else if (kind === "larger" || kind === "smaller") display?.fontSize(kind === "larger" ? 1 : -1);
    else if (kind === "close") close(id, dock);
    else {
      const session = find(id);
      if (!session) return;
      setAction({ kind, session });
    }
  }
  function menu(id?: string, dock = false, label?: string, includeSettings = true) {
    return (
      <SessionMenu
        id={id}
        session={find(id)}
        layout={layout}
        mobile={mobile}
        dock={dock}
        label={label}
        disabled={!enabled}
        onCommand={(kind, value) => command(kind, value, dock)}
        onMove={move}
        onSplit={() => void create(false, true)}
        onDirection={(direction) => patchGroup({ direction, maximized: false })}
        onSettings={includeSettings ? () => setSettings(true) : undefined}
      />
    );
  }
  function picker(dock = false) {
    return (
      <SessionPicker
        sessions={sessions}
        selected={dock ? dockId : selected}
        dock={dock}
        groups={dock ? [] : layout.groups}
        retained={[...(dock ? opened.dock : opened.main)]}
        name={name}
        iconOnly={!dock && (multipleGroups || split)}
        uncertain={remote.uncertainCreate}
        refreshDisabled={device.status !== "online"}
        onRefresh={() => void remote.refresh()}
        onDragStart={
          !dock && !mobile && selected && !multipleGroups && !split
            ? (event) => drag.start(event, selected)
            : undefined
        }
        onDragEnd={drag.end}
        onSelect={(id) => choose(id, dock)}
      />
    );
  }
  function newButtons(dock = false, showLabel = false) {
    return (
      <NewSessionButtons
        dock={dock}
        showLabel={showLabel}
        disabled={!enabled}
        shortcuts={device.snapshot?.shortcuts ?? []}
        onCreate={(shortcut) => void create(dock, false, shortcut)}
      />
    );
  }
  return (
    <>
      <div
        hidden={focusMode}
        className="flex shrink-0 items-center border-b border-border bg-muted/60 px-4 max-[959px]:px-0"
      >
        <div
          role="tablist"
          aria-label={t(($) => $.shell.tools)}
          className="flex min-w-0 flex-1 gap-5 max-[959px]:gap-0"
        >
          {[
            { id: "terminal" as const, name: t(($) => $.common.terminal), icon: Terminal },
            { id: "files" as const, name: t(($) => $.common.files), icon: Folder },
            { id: "git" as const, name: t(($) => $.common.git), icon: GitBranch },
          ].map((tool) => (
            <button
              key={tool.id}
              role="tab"
              aria-selected={route.tool === tool.id}
              className="tool-tab flex min-h-10 items-center justify-center gap-2 text-sm"
              onClick={() =>
                navigateWorkspace({ deviceId: device.id, workspaceId: workspace.id }, tool.id)
              }
            >
              <tool.icon size={15} />
              {tool.name}
            </button>
          ))}
        </div>
        {!visible && (
          <IconButton
            className="max-[959px]:hidden"
            label={
              layout.dockOpen ? t(($) => $.terminal.collapseDock) : t(($) => $.terminal.expandDock)
            }
            aria-expanded={layout.dockOpen}
            aria-controls="companion-terminal"
            onClick={() =>
              setLayout((old) => ({ ...old, dockOpen: !old.dockOpen, dock: old.dock ?? selected }))
            }
          >
            <PanelBottom />
          </IconButton>
        )}
      </div>
      <WatchStatus deviceId={device.id} workspaceId={workspace.id} />
      {!!remote.error && (
        <div
          role="alert"
          className="workbench-notice flex shrink-0 items-start gap-2 bg-red-50 px-3 py-2 text-sm text-destructive"
        >
          <div className="min-w-0 flex-1 break-words">
            <ErrorNotice error={remote.error} />
          </div>
          <IconButton label={t(($) => $.common.dismiss)} onClick={remote.clearError}>
            <X />
          </IconButton>
        </div>
      )}
      <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2">
          {picker()}
          {!mobile && (multipleGroups || drag.dragging) ? (
            <GroupTabs
              layout={layout}
              name={name}
              canDrag={(id) => !!find(id) || opened.main.has(id)}
              drag={drag}
              onSelect={choose}
            />
          ) : (
            <span className="flex-1" />
          )}
          {newButtons()}
          {!mobile && (
            <IconButton
              label={t(($) => $.terminal.createSplit)}
              disabled={!enabled}
              onClick={() => void create(false, true)}
            >
              <Columns2 />
            </IconButton>
          )}
          {!mobile && group?.maximized && members.length > 1 && (
            <IconButton
              label={t(($) => $.terminal.restoreSplit)}
              onClick={() => patchGroup({ maximized: false })}
            >
              <Minimize2 />
            </IconButton>
          )}
          <IconButton
            label={focusMode ? t(($) => $.terminal.exitFocus) : t(($) => $.terminal.enterFocus)}
            onPointerDown={(event) => {
              if (mobile) event.preventDefault();
            }}
            onClick={focusMode ? onExitFocus : onEnterFocus}
          >
            {focusMode ? <Minimize /> : <Fullscreen />}
          </IconButton>
          {menu(split ? undefined : selected)}
        </div>
        {groups.length > 0 && (
          <SplitPanes
            deviceId={device.id}
            workspaceId={workspace.id}
            groups={groups}
            current={group?.id}
            opened={opened.main}
            sessions={sessions}
            mobile={mobile}
            visible={visible}
            onSizes={(sizes) => patchGroup({ sizes })}
            events={{
              actions: register,
              focus,
              close,
              maximize: () => patchGroup({ maximized: !group?.maximized }),
              menu: (id) =>
                menu(
                  id,
                  false,
                  t(($) => $.common.actionsNamed, {
                    name: name(id),
                  }),
                  false,
                ),
              drag,
            }}
          />
        )}
        {!members.length && (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {newButtons(false, true)}
          </div>
        )}
      </div>
      <div className={visible ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ToolLayout>
          <Group
            id={`companion-${workspace.id}`}
            groupRef={dockPanels}
            orientation="vertical"
            className="min-h-0 min-w-0 flex-1"
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
            <Separator
              disabled={!dockExpanded}
              className={dockExpanded ? "split-divider" : "hidden"}
              aria-label={t(($) => $.terminal.resizeDock)}
            />
            <Panel
              id="dock"
              minSize={dockExpanded ? 170 : 0}
              maxSize={dockExpanded ? "100%" : "0%"}
              defaultSize={`${dockExpanded ? layout.dockSize : 0}%`}
              className="flex h-full min-h-0 flex-col"
            >
              <div
                id="companion-terminal"
                className={
                  dockExpanded
                    ? "flex min-h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2"
                    : "hidden"
                }
              >
                {picker(true)}
                <span className="flex-1" />
                {newButtons(true)}
                {dockId && (
                  <>
                    <IconButton
                      label={t(($) => $.terminal.expandTerminal)}
                      disabled={!find(dockId) && !opened.main.has(dockId)}
                      onClick={() => applyMain(selectSession(layout, dockId), "terminal")}
                    >
                      <Maximize2 />
                    </IconButton>
                  </>
                )}
                {menu(dockId, true)}
              </div>
              {[...opened.dock].map((id) => (
                <div
                  key={id}
                  data-dock-session-id={id}
                  className={
                    dockExpanded && dockId === id ? "flex min-h-0 flex-1 flex-col" : "hidden"
                  }
                >
                  <TerminalView
                    ref={(value) => {
                      if (value) dockActions.current.set(id, value);
                      else dockActions.current.delete(id);
                    }}
                    deviceId={device.id}
                    workspaceId={workspace.id}
                    sessionId={id}
                  />
                </div>
              ))}
              {!dockId && dockExpanded && (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  {t(($) => $.terminal.selectSession)}
                </div>
              )}
            </Panel>
          </Group>
        </ToolLayout>
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
      {settings && <TerminalSettings device={device} onClose={() => setSettings(false)} />}
    </>
  );
}
