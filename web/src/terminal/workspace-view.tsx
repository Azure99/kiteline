import { useTranslation } from "react-i18next";
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
  Rows2,
  Fullscreen,
  X,
  Minimize,
  ClipboardPaste,
  Keyboard,
  Scan,
  Search,
} from "lucide-react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { WatchStatus } from "../components/watch-status";
import { ToolLayout } from "../components/tool-layout";
import type { TerminalActions, TerminalCapabilities } from "./terminal-view";
import { TerminalView } from "./lazy-terminal-view";
import { TerminalSettings } from "./settings";
import {
  currentRoute,
  isWorkspaceRoute,
  navigateWorkspace,
  updateWorkspaceQuery,
  useRoute,
} from "../lib/navigation";
import { useMobile } from "../lib/use-mobile";
import { useSessions } from "./use-sessions";
import {
  currentGroup,
  emptyLayout,
  selectSession,
  closeSession,
  moveSession,
  retainSessions,
  members as groupMembers,
  groupFor,
  splitSession,
  arrangeGroup,
  resizeSplit,
  type MemberPosition,
  type SplitDirection,
  type TerminalLayout,
} from "./groups";
import { SplitPanes } from "./split-panes";
import { SessionMenu, type SessionCommand } from "./session-menu";
import { SessionPicker, NewSessionButtons } from "./session-controls";
import { SessionDialog, type SessionAction } from "./session-dialog";
import { GroupTabs, useTerminalDrag } from "./group-tabs";
import type { useTerminalFocus } from "./use-terminal-focus";

// Owns the shared main/dock layout while Files and Git occupy the tool region.
export function WorkspaceView({
  device,
  workspace,
  visible,
  layouts,
  focusMode,
  children,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  layouts: Map<string, TerminalLayout>;
  focusMode: ReturnType<typeof useTerminalFocus>;
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
  // A later selection prevents a pending create from taking over that region.
  const selectionEpoch = useRef({ main: 0, dock: 0 });
  const displays = useRef(new Map<string, TerminalActions>());
  const [capabilities, setCapabilities] = useState<
    Record<"main" | "dock", Record<string, TerminalCapabilities>>
  >({ main: {}, dock: {} });
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
  const find = (id?: string) => sessions.find((session) => session.id === id);
  const groups = retainSessions(
    layout,
    new Set([...sessions.map((session) => session.id), ...opened.main]),
  ).groups;
  const shownGroup = groups.find((item) => item.id === group?.id);
  const members = shownGroup ? groupMembers(shownGroup) : [];
  const targetKnown = !!routeSession && (!!find(routeSession) || opened.main.has(routeSession));
  const targetPending = !!routeSession && (!targetKnown || selected !== routeSession);
  const targetMissing =
    !targetKnown &&
    remote.loaded &&
    !remote.listError &&
    !remote.refreshing &&
    device.status === "online";
  const dockId =
    layout.dock && (find(layout.dock) || opened.dock.has(layout.dock)) ? layout.dock : undefined;
  const dockExpanded = layout.dockOpen && !mobile;
  const visibleMembers =
    visible && !targetPending
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
  function name(id: string, fallback = t(($) => $.terminal.ended)) {
    return find(id)?.name ?? names.current.get(id) ?? fallback;
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
    if (!remote.loaded && !targetKnown) return;
    // Apply navigation to the main layout; explicit layout actions update the URL below.
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
    if (routeSession) {
      if (!targetKnown) return;
      selectionEpoch.current.main++;
      lastRouteSession.current = routeSession;
      setLayout((old) => selectSession(old, routeSession));
    } else {
      lastRouteSession.current = routeSession;
      if (route.tool === "terminal" && previous !== undefined) {
        selectionEpoch.current.main++;
        setLayout((old) => ({ ...old, current: undefined }));
      }
    }
  }, [
    routeSession,
    route.tool,
    selected,
    remote.loaded,
    sessions,
    targetKnown,
    device.id,
    workspace.id,
    opened.main,
  ]);
  const register = useCallback((id: string, value: TerminalActions | null) => {
    if (value) displays.current.set(id, value);
    else displays.current.delete(id);
  }, []);
  const reportCapabilities = useCallback(
    (region: "main" | "dock", id: string, value: TerminalCapabilities | undefined) => {
      setCapabilities((old) => {
        const previous = old[region][id];
        if (previous?.ready === value?.ready && previous?.hasTerminal === value?.hasTerminal)
          return old;
        const next = { ...old[region] };
        if (value === undefined) delete next[id];
        else next[id] = value;
        return { ...old, [region]: next };
      });
    },
    [],
  );
  const reportMain = useCallback(
    (id: string, value: TerminalCapabilities | undefined) => reportCapabilities("main", id, value),
    [reportCapabilities],
  );
  const reportDock = useCallback(
    (id: string, value: TerminalCapabilities | undefined) => reportCapabilities("dock", id, value),
    [reportCapabilities],
  );
  // Explicit main-layout actions also publish their selected session to the URL.
  function applyMain(next: TerminalLayout, tool = route.tool, replace = false) {
    selectionEpoch.current.main++;
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
    if (dock) {
      selectionEpoch.current.dock++;
      setLayout((old) => ({ ...old, dock: id, dockOpen: true }));
    } else applyMain(selectSession(layout, id));
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
    if (dock) {
      selectionEpoch.current.dock++;
      setLayout((old) => ({ ...old, dock: undefined }));
    } else applyMain(closeSession(layout, id));
  }
  function move(id: string, target?: string, position?: MemberPosition) {
    applyMain(moveSession(layout, id, target, position));
  }
  const drag = useTerminalDrag(move);
  function patchGroup(change: Partial<NonNullable<typeof group>>) {
    if (!group) return;
    selectionEpoch.current.main++;
    setLayout((old) => ({
      ...old,
      groups: old.groups.map((item) => (item.id === group.id ? { ...item, ...change } : item)),
    }));
  }
  async function create({
    dock = false,
    shortcutId,
    split,
  }: {
    dock?: boolean;
    shortcutId?: string;
    split?: { groupId: string; anchor: string; direction: SplitDirection };
  } = {}) {
    const intent = { ...selectionEpoch.current };
    const session = await remote.create(shortcutId);
    if (!session) return;
    const current = currentRoute();
    const activate =
      selectionEpoch.current[dock ? "dock" : "main"] === intent[dock ? "dock" : "main"] &&
      (dock ||
        !isWorkspaceRoute(current, { deviceId: device.id, workspaceId: workspace.id }) ||
        (current.query.session ?? null) === routeSession);
    setLayout((old) => {
      if (dock) return activate ? { ...old, dock: session.id, dockOpen: true } : old;
      const next = split
        ? splitSession(old, session.id, split.groupId, split.anchor, split.direction)
        : selectSession(old, session.id);
      if (!activate) {
        // Place the result at its original anchor without replacing a later selection.
        const active = currentGroup(old)?.active;
        for (const group of next.groups) {
          const previous = old.groups.find((item) => item.id === group.id);
          if (previous && groupMembers(group).includes(previous.active)) {
            group.active = previous.active;
            group.maximized = previous.maximized;
          }
        }
        const current = active ? groupFor(next, active) : undefined;
        next.current = current?.id;
        if (current && active) current.active = active;
      }
      return {
        ...next,
        dock: old.dock ?? (selectionEpoch.current.dock === intent.dock ? session.id : undefined),
      };
    });
    if (!dock && activate) {
      lastRouteSession.current = session.id;
      updateWorkspaceQuery(
        { deviceId: device.id, workspaceId: workspace.id },
        { session: session.id },
      );
    }
  }
  function createSplit(id: string | undefined, direction: SplitDirection) {
    const owner = id ? groupFor(layout, id) : undefined;
    void create({ split: owner && id ? { groupId: owner.id, anchor: id, direction } : undefined });
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
  function menu({
    id,
    dock = false,
    label,
    includeSettings = true,
  }: {
    id?: string;
    dock?: boolean;
    label?: string;
    includeSettings?: boolean;
  } = {}) {
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
        onSplit={(direction) => createSplit(id, direction)}
        onDirection={(direction) => {
          const owner = id ? groupFor(layout, id) : undefined;
          if (owner) setLayout((old) => arrangeGroup(old, owner.id, direction));
        }}
        onSettings={includeSettings ? () => setSettings(true) : undefined}
      />
    );
  }
  function picker(dock = false) {
    return (
      <SessionPicker
        sessions={sessions}
        selected={dock ? dockId : targetPending ? undefined : selected}
        dock={dock}
        groups={dock ? [] : layout.groups}
        retained={[...(dock ? opened.dock : opened.main)]}
        name={name}
        iconOnly={!dock && (mobile || multipleGroups || split)}
        uncertain={remote.uncertainCreate}
        refreshDisabled={device.status !== "online"}
        onRefresh={() => void remote.refresh()}
        onDragStart={
          !dock && !targetPending && !mobile && selected && !multipleGroups && !split
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
        onCreate={(shortcutId) => void create({ dock, shortcutId })}
      />
    );
  }
  return (
    <>
      <div
        hidden={focusMode.active}
        className="flex shrink-0 items-center border-b border-border bg-muted/60 px-4 max-desk:px-0"
      >
        <div
          role="tablist"
          aria-label={t(($) => $.shell.tools)}
          className="flex min-w-0 flex-1 gap-5 max-desk:gap-0"
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
            className="max-desk:hidden"
            label={
              layout.dockOpen ? t(($) => $.terminal.collapseDock) : t(($) => $.terminal.expandDock)
            }
            aria-expanded={layout.dockOpen}
            aria-controls="companion-terminal"
            onClick={() => {
              selectionEpoch.current.dock++;
              setLayout((old) => ({ ...old, dockOpen: !old.dockOpen, dock: old.dock ?? selected }));
            }}
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
        {focusMode.error && (
          <div role="status" className="flex shrink-0 items-center gap-2 px-3 text-sm">
            <span className="flex-1">{t(($) => $.terminal[focusMode.error!])}</span>
            <IconButton label={t(($) => $.common.dismiss)} onClick={focusMode.dismiss}>
              <X />
            </IconButton>
          </div>
        )}
        <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2 max-desk:gap-0 max-desk:px-1">
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
          {mobile && (
            <>
              {typeof navigator.clipboard?.readText === "function" && (
                <IconButton
                  label={t(($) => $.terminal.paste)}
                  disabled={targetPending || !selected || !capabilities.main[selected]?.ready}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (selected && !targetPending) void displays.current.get(selected)?.paste();
                  }}
                >
                  <ClipboardPaste />
                </IconButton>
              )}
              <IconButton
                label={t(($) => $.terminal.keyboard)}
                disabled={targetPending || !selected || !capabilities.main[selected]?.ready}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (selected && !targetPending) displays.current.get(selected)?.keyboard();
                }}
              >
                <Keyboard />
              </IconButton>
            </>
          )}
          {!mobile && (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!enabled}
                    aria-label={t(($) => $.terminal.createSplit)}
                  />
                }
              >
                <Columns2 />
              </MenuTrigger>
              <MenuContent>
                <MenuItem onClick={() => createSplit(selected, "horizontal")}>
                  <Columns2 />
                  {t(($) => $.terminal.splitRight)}
                </MenuItem>
                <MenuItem onClick={() => createSplit(selected, "vertical")}>
                  <Rows2 />
                  {t(($) => $.terminal.splitDown)}
                </MenuItem>
              </MenuContent>
            </Menu>
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
            label={t(($) => $.terminal.search)}
            disabled={targetPending || !selected || !capabilities.main[selected]?.hasTerminal}
            onClick={() => {
              if (selected && !targetPending) displays.current.get(selected)?.search();
            }}
          >
            <Search />
          </IconButton>
          <IconButton
            label={t(($) => $.terminal[focusMode.next])}
            aria-pressed={focusMode.active || focusMode.fullscreen}
            onPointerDown={(event) => {
              if (mobile) event.preventDefault();
            }}
            onClick={focusMode.toggle}
          >
            {focusMode.next === "exitFocus" ? (
              <Minimize />
            ) : focusMode.next === "enterFullscreen" ? (
              <Fullscreen />
            ) : (
              <Scan />
            )}
          </IconButton>
          {menu({ id: split || targetPending ? undefined : selected })}
        </div>
        {targetPending && (
          <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-auto p-4 text-sm">
            <p role="status">
              {targetMissing
                ? t(($) => $.terminal.missing)
                : remote.refreshing
                  ? t(($) => $.terminal.checkingTarget)
                  : t(($) => $.terminal.targetUnknown)}
            </p>
            <p className="break-all font-mono text-xs">{routeSession}</p>
            <Button
              variant="outline"
              disabled={device.status !== "online" || remote.refreshing}
              onClick={() => void remote.refresh()}
            >
              {t(($) => $.common.retry)}
            </Button>
          </div>
        )}
        {groups.length > 0 && (
          <SplitPanes
            deviceId={device.id}
            workspaceId={workspace.id}
            groups={groups}
            current={targetPending ? undefined : group?.id}
            opened={opened.main}
            mobile={mobile}
            visible={visible && !targetPending}
            onSizes={(groupId, splitId, sizes) =>
              setLayout((old) => resizeSplit(old, groupId, splitId, sizes))
            }
            events={{
              name,
              actions: register,
              capabilities: reportMain,
              focus,
              close,
              maximize: () => patchGroup({ maximized: !group?.maximized }),
              menu: (id) =>
                menu({
                  id,
                  label: t(($) => $.common.actionsNamed, {
                    name: name(id),
                  }),
                  includeSettings: false,
                }),
              drag,
            }}
          />
        )}
        {!members.length && !targetPending && (
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
                <IconButton
                  label={t(($) => $.terminal.search)}
                  disabled={!dockExpanded || !dockId || !capabilities.dock[dockId]?.hasTerminal}
                  onClick={() => {
                    if (dockExpanded && dockId) dockActions.current.get(dockId)?.search();
                  }}
                >
                  <Search />
                </IconButton>
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
                {menu({ id: dockId, dock: true })}
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
                    onCapabilities={reportDock}
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
          environment={device.status === "online" ? device.environment : undefined}
          onClose={() => setAction(undefined)}
          onChange={remote.change}
        />
      )}
      {settings && <TerminalSettings device={device} onClose={() => setSettings(false)} />}
    </>
  );
}
