import { ApplicationTitle } from "./application-title";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Minimize2, Columns2, Rows2, Fullscreen, X, Minimize, Scan, Search } from "lucide-react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { useWatchStatus } from "../lib/use-workspace-refresh";
import { WatchStatus } from "../components/watch-status";
import type { TerminalActions, TerminalCapabilities } from "./terminal-view";
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

export function WorkspaceView({
  device,
  workspace,
  visible,
  layouts,
  onLayout,
  onActivateTerminal,
  activationRequest,
  focusMode,
  onCliSetup,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  layouts: ReadonlyMap<string, TerminalLayout>;
  onLayout(key: string, layout: TerminalLayout): void;
  onActivateTerminal(deviceId: string, workspaceId: string, sessionId: string): void;
  activationRequest: number;
  focusMode: ReturnType<typeof useTerminalFocus>;
  onCliSetup(): void;
}) {
  const { t } = useTranslation();
  const watchReason = useWatchStatus(device.id, workspace.id);
  const [watchDismissed, setWatchDismissed] = useState(false);

  const key = `${device.id}:${workspace.id}`;
  const [layout, setLayout] = useState(() => layouts.get(key) ?? emptyLayout());
  const remote = useSessions(device, workspace.id);
  const mobile = useMobile();
  const route = useRoute();
  const routeSession = route.query.session ?? null;
  const lastRouteSession = useRef<string | null | undefined>(undefined);
  const lastTool = useRef<string | undefined>(undefined);
  // A later selection prevents a pending create from taking over that region.
  const selectionEpoch = useRef(0);
  const displays = useRef(new Map<string, TerminalActions>());
  const [mainSearchHost, setMainSearchHost] = useState<HTMLDivElement | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, TerminalCapabilities>>({});
  const names = useRef(new Map<string, string>());
  const [opened, setOpened] = useState(() => new Set<string>());
  const [settings, setSettings] = useState(false);
  const [action, setAction] = useState<SessionAction>();
  const group = currentGroup(layout);
  const selected = group?.active;
  const sessions = remote.sessions;
  const find = (id?: string) => sessions.find((session) => session.id === id);
  const groups = retainSessions(
    layout,
    new Set([...sessions.map((session) => session.id), ...opened]),
  ).groups;
  const shownGroup = groups.find((item) => item.id === group?.id);
  const members = shownGroup ? groupMembers(shownGroup) : [];
  const targetKnown = !!routeSession && (!!find(routeSession) || opened.has(routeSession));
  const targetPending = !!routeSession && (!targetKnown || selected !== routeSession);
  const targetMissing =
    !targetKnown &&
    remote.loaded &&
    !remote.listError &&
    !remote.refreshing &&
    device.status === "online";
  const visibleMembers =
    visible && !targetPending
      ? members.filter((id) => (!mobile && !group?.maximized) || id === selected).join(",")
      : "";
  useLayoutEffect(() => {
    const main = visibleMembers ? visibleMembers.split(",") : [];
    setOpened((old) => (main.every((id) => old.has(id)) ? old : new Set([...old, ...main])));
  }, [visibleMembers]);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setPageVisible(!document.hidden);
    const hide = () => setPageVisible(false);
    document.addEventListener("visibilitychange", change);
    window.addEventListener("pageshow", change);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", change);
      window.removeEventListener("pageshow", change);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  const activatedSession =
    pageVisible && visible && !targetPending && selected && (find(selected) || opened.has(selected))
      ? selected
      : undefined;
  useLayoutEffect(() => {
    if (activatedSession) onActivateTerminal(device.id, workspace.id, activatedSession);
  }, [activatedSession, visible, activationRequest, device.id, workspace.id, onActivateTerminal]);
  const enabled = device.status === "online" && !remote.busy;
  const split = !mobile && members.length > 1 && !group?.maximized;
  const multipleGroups = !mobile && layout.groups.length > 1;
  function name(id: string, fallback = t(($) => $.terminal.ended)) {
    return find(id)?.name ?? names.current.get(id) ?? fallback;
  }
  useEffect(() => {
    for (const session of sessions) names.current.set(session.id, session.name);
    for (const id of names.current.keys())
      if (!sessions.some((session) => session.id === id) && !opened.has(id))
        names.current.delete(id);
  }, [sessions, opened]);
  useEffect(() => {
    onLayout(key, layout);
  }, [key, layout, onLayout]);
  useEffect(() => {
    if (!remote.loaded) return;
    const kept = new Set([...sessions.map((session) => session.id), ...opened]);
    setLayout((old) => retainSessions(old, kept));
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
      selectionEpoch.current++;
      lastRouteSession.current = routeSession;
      setLayout((old) => selectSession(old, routeSession));
    } else {
      lastRouteSession.current = routeSession;
      if (route.tool === "terminal" && previous !== undefined) {
        selectionEpoch.current++;
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
    opened,
  ]);
  const register = useCallback((id: string, value: TerminalActions | null) => {
    if (value) displays.current.set(id, value);
    else displays.current.delete(id);
  }, []);
  const reportCapabilities = useCallback((id: string, value: TerminalCapabilities | undefined) => {
    setCapabilities((old) => {
      const previous = old[id];
      if (
        previous?.ready === value?.ready &&
        previous?.hasTerminal === value?.hasTerminal &&
        previous?.title === value?.title
      )
        return old;
      const next = { ...old };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }, []);
  // Explicit main-layout actions also publish their selected session to the URL.
  function applyMain(next: TerminalLayout, tool = route.tool, replace = false) {
    selectionEpoch.current++;
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
  function choose(id: string) {
    if (!find(id) && !opened.has(id)) return;
    if (activatedSession === id && visible) onActivateTerminal(device.id, workspace.id, id);
    applyMain(selectSession(layout, id));
  }
  function focus(id: string) {
    if (selected !== id) applyMain(selectSession(layout, id), route.tool, true);
  }
  function close(id: string) {
    setOpened((old) => {
      const next = new Set(old);
      next.delete(id);
      return next;
    });
    applyMain(closeSession(layout, id));
  }
  function move(id: string, target?: string, position?: MemberPosition) {
    applyMain(moveSession(layout, id, target, position));
  }
  const drag = useTerminalDrag(move);
  function patchGroup(change: Partial<NonNullable<typeof group>>) {
    if (!group) return;
    selectionEpoch.current++;
    setLayout((old) => ({
      ...old,
      groups: old.groups.map((item) => (item.id === group.id ? { ...item, ...change } : item)),
    }));
  }
  async function create({
    shortcutId,
    split,
  }: {
    shortcutId?: string;
    split?: { groupId: string; anchor: string; direction: SplitDirection };
  } = {}) {
    const intent = selectionEpoch.current;
    const session = await remote.create(shortcutId);
    if (!session) return;
    const current = currentRoute();
    const activate =
      selectionEpoch.current === intent &&
      (!isWorkspaceRoute(current, { deviceId: device.id, workspaceId: workspace.id }) ||
        (current.query.session ?? null) === routeSession);
    setLayout((old) => {
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
      return next;
    });
    if (activate) {
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
  function command(kind: SessionCommand, id: string) {
    const display = displays.current.get(id);
    if (kind === "redraw") display?.redraw();
    else if (kind === "larger" || kind === "smaller") display?.fontSize(kind === "larger" ? 1 : -1);
    else if (kind === "close") close(id);
    else {
      const session = find(id);
      if (!session) return;
      if (kind !== "attach") remote.clearMutationError();
      setAction({ kind, session });
    }
  }
  function menu({
    id,
    label,
    includeSettings = true,
  }: {
    id?: string;
    label?: string;
    includeSettings?: boolean;
  } = {}) {
    return (
      <SessionMenu
        id={id}
        session={find(id)}
        layout={layout}
        busy={remote.busy}
        mobile={mobile}
        label={label}
        onCommand={(kind, value) => command(kind, value)}
        onMove={move}
        onDirection={(direction) => {
          const owner = id ? groupFor(layout, id) : undefined;
          if (owner) setLayout((old) => arrangeGroup(old, owner.id, direction));
        }}
        onSettings={includeSettings ? () => setSettings(true) : undefined}
        onSearch={
          mobile && includeSettings
            ? () => {
                if (id) displays.current.get(id)?.search();
              }
            : undefined
        }
        searchDisabled={!id || !capabilities[id]?.hasTerminal}
      />
    );
  }
  function picker() {
    return (
      <SessionPicker
        sessions={sessions}
        selected={targetPending ? undefined : selected}
        groups={layout.groups}
        retained={[...opened]}
        name={name}
        iconOnly={!mobile && (multipleGroups || split)}
        uncertain={remote.uncertainCreate}
        refreshDisabled={device.status !== "online"}
        onRefresh={() => void remote.refresh()}
        onDragStart={
          !targetPending && !mobile && selected && !multipleGroups && !split
            ? (event) => drag.start(event, selected)
            : undefined
        }
        onDragEnd={drag.end}
        onSelect={(id) => choose(id)}
      />
    );
  }
  function newButtons(showLabel = false) {
    return (
      <NewSessionButtons
        showLabel={showLabel}
        disabled={!enabled}
        shortcuts={device.snapshot?.shortcuts ?? []}
        onCreate={(shortcutId) => void create({ shortcutId })}
      />
    );
  }
  return (
    <>
      {!watchDismissed && (
        <WatchStatus reason={watchReason} onDismiss={() => setWatchDismissed(true)} />
      )}
      {!!remote.error &&
        (!action || action.kind === "attach" || remote.error !== remote.mutationError) &&
        (visible || remote.error !== remote.listError) && (
          <div
            role="alert"
            className="workbench-notice flex shrink-0 items-start gap-2 bg-danger-soft px-3 py-2 text-sm text-destructive"
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
        <div ref={setMainSearchHost} className="relative shrink-0">
          <div
            data-search-controls
            className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border bg-muted px-2 max-desk:gap-0 max-desk:px-1"
          >
            {picker()}
            {watchDismissed && <WatchStatus reason={watchReason} compact />}
            {!mobile && (multipleGroups || drag.dragging) ? (
              <GroupTabs
                layout={layout}
                name={name}
                canDrag={(id) => !!find(id) || opened.has(id)}
                drag={drag}
                onSelect={choose}
              />
            ) : null}
            {(!split || !multipleGroups) && (
              <span className="flex min-w-0 flex-1 overflow-hidden px-1">
                {!split && (
                  <ApplicationTitle
                    title={!targetPending && selected ? capabilities[selected]?.title : undefined}
                  />
                )}
              </span>
            )}
            {newButtons()}
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
            {!mobile && (
              <IconButton
                label={t(($) => $.terminal.search)}
                disabled={targetPending || !selected || !capabilities[selected]?.hasTerminal}
                onClick={() => {
                  if (selected && !targetPending) displays.current.get(selected)?.search();
                }}
              >
                <Search />
              </IconButton>
            )}
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
        </div>
        {targetPending && (
          <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-auto p-4 text-sm">
            <p role="status">
              {targetMissing
                ? t(($) => $.terminal.missing)
                : targetKnown ||
                    remote.refreshing ||
                    (!remote.loaded && !remote.listError && device.status === "online")
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
            workspacePath={workspace.path}
            groups={groups}
            current={targetPending ? undefined : group?.id}
            opened={opened}
            searchHost={mainSearchHost}
            mobile={mobile}
            visible={visible && !targetPending}
            onSizes={(groupId, splitId, sizes) =>
              setLayout((old) => resizeSplit(old, groupId, splitId, sizes))
            }
            events={{
              name,
              actions: register,
              capabilities: reportCapabilities,
              title: (id) => capabilities[id]?.title,
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
          <div className="flex min-h-0 flex-1 items-center justify-center">{newButtons(true)}</div>
        )}
      </div>
      {action && (
        <SessionDialog
          key={`${action.kind}:${action.session.id}`}
          action={action}
          busy={remote.busy}
          error={remote.mutationError}
          device={device}
          workspace={workspace}
          onCliSetup={onCliSetup}
          onClose={() => setAction(undefined)}
          onChange={remote.change}
        />
      )}
      {settings && <TerminalSettings device={device} onClose={() => setSettings(false)} />}
    </>
  );
}
