import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { X } from "lucide-react";
import type { Device, Workspace } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { FocusCycleButton } from "../components/focus-cycle-button";
import { Button } from "../components/ui/button";
import { useWatchStatus } from "../lib/use-workspace-refresh";
import { WatchStatus } from "../components/watch-status";
import type { TerminalActions, TerminalCapabilities } from "./terminal-view";
import { TerminalSettings } from "./settings";
import {
  currentRoute,
  isWorkspaceRoute,
  updateWorkspaceQuery,
  useRoute,
  type NavigationOptions,
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
  placeCreatedSession,
  arrangeGroup,
  resizeSplit,
  showGroup,
  type MemberPosition,
  type SplitDirection,
  type TerminalLayout,
} from "./groups";
import { SplitPanes } from "./split-panes";
import {
  SessionObjectMenu,
  SessionSubmenu,
  type TerminalCommand,
  type SessionMenuProps,
} from "./session-menu";
import { TerminalMenu } from "./terminal-menu";
import { SessionPicker, NewSessionButtons, type SessionPickerVariant } from "./session-controls";
import { SessionDialog, type SessionAction } from "./session-dialog";
import { GroupTabs, useTerminalDrag } from "./group-tabs";
import { ApplicationTitle } from "./application-title";
import type { useTerminalFocus } from "./use-terminal-focus";
import type { ReceivedReport } from "./reports";
import type { CliAttachTarget } from "../cli/cli-dialog";

export function TerminalArea({
  device,
  workspace,
  visible,
  initialLayout,
  onLayout,
  onActivateTerminal,
  activationRequest,
  focusMode,
  reports,
  onCliAttach,
  onSelectTerminal,
}: {
  device: Device;
  workspace: Workspace;
  visible: boolean;
  initialLayout?: TerminalLayout;
  onLayout(layout: TerminalLayout): void;
  onActivateTerminal(deviceId: string, workspaceId: string, sessionId: string): void;
  activationRequest: number;
  focusMode: ReturnType<typeof useTerminalFocus>;
  reports: readonly ReceivedReport[];
  onCliAttach(target: CliAttachTarget): void;
  onSelectTerminal(): void;
}) {
  const { t } = useTranslation();
  const watchReason = useWatchStatus(device.id, workspace.id);
  const [watchDismissed, setWatchDismissed] = useState(false);

  const [layout, setLayout] = useState(() => initialLayout ?? emptyLayout());
  const remote = useSessions(device, workspace.id);
  const mobile = useMobile();
  const route = useRoute();
  const [mobileSession, setMobileSession] = useState(
    () => route.query.session ?? currentGroup(layout)?.active,
  );
  const routeSession = route.query.session ?? null;
  const lastRouteSession = useRef<string | null | undefined>(undefined);
  const lastActivationRequest = useRef(activationRequest);
  const lastTool = useRef<string | undefined>(undefined);
  // A later selection prevents a pending create from taking over that region.
  const selectionEpoch = useRef(0);
  const revealRequest = useRef<string>(undefined);
  const displays = useRef(new Map<string, TerminalActions>());
  const [pendingFocus, setPendingFocus] = useState<{
    id: string;
    epoch: number;
    menuClosed: boolean;
  }>();
  const [mainSearchHost, setMainSearchHost] = useState<HTMLDivElement | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, TerminalCapabilities>>({});
  const names = useRef(new Map<string, string>());
  const [opened, setOpened] = useState(() => new Set<string>());
  const [settings, setSettings] = useState(false);
  const [action, setAction] = useState<SessionAction>();
  const sessionError = remote.mutationError || remote.listNotice;
  const sessionErrorVisible = remote.mutationError ? !action : visible;
  const group = currentGroup(layout);
  const selected = mobile ? mobileSession : group?.active;
  const sessions = remote.sessions;
  const sessionReports = new Map(
    reports
      .filter((report) => report.deviceId === device.id && report.workspaceId === workspace.id)
      .map((report) => [report.sessionId, report]),
  );
  const find = (id?: string) => sessions.find((session) => session.id === id);
  const groups = retainSessions(
    layout,
    new Set([...sessions.map((session) => session.id), ...opened]),
  ).groups;
  const shownGroup = groups.find((item) => item.id === group?.id);
  const members = shownGroup ? groupMembers(shownGroup) : [];
  // Displays use the same list as the picker's "Ended" mark; it never reconnects them.
  const missing = new Set(remote.loaded ? [...opened].filter((id) => !find(id)) : []);
  const targetKnown = !!routeSession && (!!find(routeSession) || opened.has(routeSession));
  const targetPending = !!routeSession && (!targetKnown || selected !== routeSession);
  const targetMissing = remote.loaded && !targetKnown;
  let visibleIds: string[];
  if (!visible || targetPending) visibleIds = [];
  else if (mobile) visibleIds = selected ? [selected] : [];
  else visibleIds = members.filter((id) => !group?.maximized || id === selected);
  const searchOpen =
    !!selected && visibleIds.includes(selected) && !!capabilities[selected]?.searchOpen;
  useLayoutEffect(() => {
    setOpened((old) =>
      visibleIds.every((id) => old.has(id)) ? old : new Set([...old, ...visibleIds]),
    );
  }, [visibleIds]);
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
    pageVisible && visible
      ? routeSession && targetMissing && device.status === "online"
        ? routeSession
        : !targetPending && selected && (find(selected) || opened.has(selected))
          ? selected
          : undefined
      : undefined;
  useLayoutEffect(() => {
    if (activatedSession) onActivateTerminal(device.id, workspace.id, activatedSession);
  }, [activatedSession, visible, activationRequest, device.id, workspace.id, onActivateTerminal]);
  const enabled = device.status === "online" && !remote.busy;
  function name(id: string) {
    return find(id)?.name ?? names.current.get(id) ?? t(($) => $.terminal.ended);
  }
  useEffect(() => {
    for (const session of sessions) names.current.set(session.id, session.name);
    for (const id of names.current.keys())
      if (!sessions.some((session) => session.id === id) && !opened.has(id))
        names.current.delete(id);
  }, [sessions, opened]);
  useEffect(() => {
    onLayout(layout);
  }, [layout, onLayout]);
  useEffect(() => {
    if (!remote.loaded) return;
    const kept = new Set([...sessions.map((session) => session.id), ...opened]);
    setLayout((old) => retainSessions(old, kept));
  }, [sessions, remote.loaded, opened]);
  const publishSelection = useCallback(
    (id: string | undefined, options?: NavigationOptions) => {
      lastRouteSession.current = id ?? null;
      const target = { deviceId: device.id, workspaceId: workspace.id };
      updateWorkspaceQuery(target, { session: id }, options);
    },
    [device.id, workspace.id],
  );
  const commitSelection = useCallback(
    (id: string | undefined, { reveal }: { reveal?: "show" | "clear" } = {}) => {
      selectionEpoch.current++;
      if (reveal === "clear") revealRequest.current = undefined;
      else if (reveal === "show" && !mobile) revealRequest.current = id;
      if (mobile) setMobileSession(id);
      else setLayout((old) => (id ? selectSession(old, id) : { ...old, current: undefined }));
    },
    [mobile],
  );
  const selectAndPublish = useCallback(
    (id: string | undefined, reveal?: "show" | "clear", options?: NavigationOptions) => {
      commitSelection(id, { reveal });
      publishSelection(id, options);
    },
    [commitSelection, publishSelection],
  );
  const previousSelection = useRef({ mobile, selected });
  useLayoutEffect(() => {
    const before = previousSelection.current;
    previousSelection.current = { mobile, selected };
    if (before.mobile === mobile) return;
    // An explicit unresolved route remains authoritative during the handoff.
    if (routeSession && (!targetKnown || lastRouteSession.current !== routeSession)) return;
    const id = before.selected;
    selectAndPublish(id, "show", { replace: true });
  }, [mobile, selected, routeSession, targetKnown, selectAndPublish]);
  useEffect(() => {
    // Report navigation can explicitly select the same route again.
    const activationChanged = lastActivationRequest.current !== activationRequest;
    lastActivationRequest.current = activationRequest;
    if (!remote.loaded && !targetKnown) return;
    // Mobile selection and desktop groups share the URL, not their layout state.
    const returning = route.tool === "terminal" && lastTool.current !== "terminal";
    lastTool.current = route.tool;
    if (returning && !routeSession && selected) {
      publishSelection(selected, { replace: true });
      return;
    }
    if (lastRouteSession.current === routeSession && !activationChanged) return;
    const previous = lastRouteSession.current;
    if (routeSession) {
      if (!targetKnown) return;
      lastRouteSession.current = routeSession;
      commitSelection(routeSession, { reveal: "show" });
    } else {
      lastRouteSession.current = routeSession;
      if (route.tool === "terminal" && previous !== undefined) commitSelection(undefined);
    }
  }, [
    routeSession,
    activationRequest,
    mobile,
    route.tool,
    selected,
    remote.loaded,
    sessions,
    targetKnown,
    commitSelection,
    publishSelection,
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
        previous?.title === value?.title &&
        previous?.searchOpen === value?.searchOpen
      )
        return old;
      const next = { ...old };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }, []);
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    if (
      mobile ||
      !visible ||
      !pageVisible ||
      routeSession !== pendingFocus.id ||
      selectionEpoch.current !== pendingFocus.epoch
    ) {
      setPendingFocus(undefined);
      return;
    }
    if (
      !pendingFocus.menuClosed ||
      targetPending ||
      selected !== pendingFocus.id ||
      !capabilities[pendingFocus.id]?.ready
    )
      return;
    const display = displays.current.get(pendingFocus.id);
    if (!display) return;
    setPendingFocus(undefined);
    display.focus();
  }, [
    pendingFocus,
    mobile,
    visible,
    pageVisible,
    routeSession,
    targetPending,
    selected,
    capabilities,
  ]);
  useEffect(() => {
    if (!pendingFocus) return;
    const cancel = () => setPendingFocus(undefined);
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
    };
  }, [pendingFocus]);
  // Explicit main-layout actions also publish their selected session to the URL.
  function applyLayout(next: TerminalLayout) {
    selectionEpoch.current++;
    setLayout(next);
    publishSelection(currentGroup(next)?.active);
  }
  function choose(
    id: string,
    { keyboard = false, menu = "closed" }: { keyboard?: boolean; menu?: "closed" | "closing" } = {},
  ) {
    if (!find(id) && !opened.has(id)) return;
    onSelectTerminal();
    if (activatedSession === id && visible) onActivateTerminal(device.id, workspace.id, id);
    selectAndPublish(id, "show");
    setPendingFocus(
      keyboard && !mobile
        ? { id, epoch: selectionEpoch.current, menuClosed: menu === "closed" }
        : undefined,
    );
  }
  function focus(id: string) {
    if (selected !== id) {
      selectAndPublish(id, "clear", { replace: true });
    }
  }
  function close(id: string) {
    if (!mobile || !groupFor(layout, id)) {
      setOpened((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
    }
    if (mobile) {
      if (selected === id) {
        selectAndPublish(undefined);
      }
      return;
    }
    applyLayout(closeSession(layout, id));
  }
  function move(id: string, target?: string, position?: MemberPosition) {
    applyLayout(moveSession(layout, id, target, position));
  }
  const drag = useTerminalDrag(move);
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
    if (mobile) {
      if (activate) {
        onSelectTerminal();
        selectAndPublish(session.id);
      }
      return;
    }
    setLayout((old) => placeCreatedSession(old, session.id, { activate, split }));
    if (activate) {
      onSelectTerminal();
      publishSelection(session.id);
    }
  }
  function createSplit(id: string | undefined, direction: SplitDirection) {
    const owner = id ? groupFor(layout, id) : undefined;
    void create({ split: owner && id ? { groupId: owner.id, anchor: id, direction } : undefined });
  }
  function command(kind: TerminalCommand, id: string) {
    const display = displays.current.get(id);
    if (kind === "redraw") display?.redraw();
    else if (kind === "larger" || kind === "smaller") display?.fontSize(kind === "larger" ? 1 : -1);
    else if (kind === "close") close(id);
    else {
      const session = find(id);
      if (!session) return;
      if (kind === "attach") onCliAttach({ device, workspace, session });
      else {
        remote.clearMutationError();
        setAction({ kind, session });
      }
    }
  }
  function menuProps(id: string): SessionMenuProps {
    return {
      id,
      session: find(id),
      targetName: name(id),
      targetTitle: capabilities[id]?.title,
      layout,
      mutationDisabled: !enabled,
      mobile,
      canClose: mobile ? id === selected : !!groupFor(layout, id),
      label: t(($) => $.common.actionsNamed, { name: name(id) }),
      onCommand: command,
      onMove: move,
    };
  }
  function objectMenu(id: string, trigger: ReactElement) {
    return <SessionObjectMenu {...menuProps(id)}>{trigger}</SessionObjectMenu>;
  }
  function picker(variant: SessionPickerVariant) {
    return (
      <SessionPicker
        variant={variant}
        sessions={sessions}
        selected={targetPending ? undefined : selected}
        groups={mobile ? [] : layout.groups}
        retained={[...opened]}
        reports={sessionReports}
        name={name}
        onShowGroup={mobile ? undefined : (id, shown) => applyLayout(showGroup(layout, id, shown))}
        refreshDisabled={device.status !== "online"}
        onRefresh={() => void remote.refresh()}
        onSelect={(id, keyboard) => choose(id, { keyboard, menu: "closing" })}
        focusOnKeyboard={!mobile}
        onSelectionComplete={() =>
          setPendingFocus((pending) => (pending ? { ...pending, menuClosed: true } : undefined))
        }
        objectMenu={(id) => <SessionSubmenu {...menuProps(id)} />}
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
      {!!sessionError && sessionErrorVisible && (
        <div
          role="alert"
          className="workbench-notice flex shrink-0 items-start gap-2 bg-danger-soft px-3 py-2 text-sm text-destructive"
        >
          <div className="min-w-0 flex-1 break-words">
            <ErrorNotice error={sessionError} />
          </div>
          <IconButton label={t(($) => $.common.dismiss)} onClick={remote.dismissNotice}>
            <X />
          </IconButton>
        </div>
      )}
      <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <div className="flex shrink-0 items-start">
          <div ref={setMainSearchHost} className="relative min-w-0 flex-1">
            <div
              hidden={searchOpen}
              className="terminal-toolbar flex min-h-10 shrink-0 items-center gap-1 border-b border-border bg-muted px-2 max-desk:gap-0 max-desk:px-1"
            >
              {picker(mobile ? "current" : "icon")}
              {watchDismissed && <WatchStatus reason={watchReason} compact />}
              {!mobile && !targetPending && (
                <GroupTabs
                  layout={layout}
                  name={name}
                  reported={(id) => sessionReports.has(id)}
                  canDrag={(id) => !mobile && (!!find(id) || opened.has(id))}
                  drag={drag}
                  onSelect={(id, keyboard) => choose(id, { keyboard })}
                  objectMenu={objectMenu}
                />
              )}
              <span className="flex min-w-0 flex-1 overflow-hidden px-1">
                <ApplicationTitle
                  title={!targetPending && selected ? capabilities[selected]?.title : undefined}
                />
              </span>
              {newButtons()}
              <FocusCycleButton
                active={focusMode.active}
                fullscreen={focusMode.fullscreen}
                enterFocusLabel={t(($) => $.terminal.enterFocus)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={focusMode.toggle}
              />
              <TerminalMenu
                id={targetPending ? undefined : selected}
                targetName={!targetPending && selected ? name(selected) : undefined}
                targetTitle={!targetPending && selected ? capabilities[selected]?.title : undefined}
                group={targetPending ? undefined : group}
                hasDisplay={
                  !targetPending &&
                  !!selected &&
                  opened.has(selected) &&
                  !!capabilities[selected]?.hasTerminal
                }
                canRedraw={!!find(selected)}
                mutationDisabled={!enabled}
                mobile={mobile}
                onCommand={command}
                onSplit={(direction) => createSplit(selected, direction)}
                onMaximize={() => {
                  if (!group || !selected) return;
                  const next = selectSession(layout, selected);
                  currentGroup(next)!.maximized = !group.maximized;
                  applyLayout(next);
                }}
                onDirection={(direction) => {
                  if (group) {
                    revealRequest.current = group.active;
                    setLayout((old) => arrangeGroup(old, group.id, direction));
                  }
                }}
                onSearch={() => {
                  if (selected && !targetPending) {
                    choose(selected);
                    displays.current.get(selected)?.search();
                  }
                }}
                onSettings={() => setSettings(true)}
              />
            </div>
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
        {(groups.length > 0 || opened.size > 0) && (
          <SplitPanes
            deviceId={device.id}
            deviceName={device.name}
            workspaceId={workspace.id}
            workspacePath={workspace.path}
            name={name}
            groups={groups}
            current={targetPending ? undefined : group?.id}
            opened={opened}
            missing={missing}
            revealRequest={revealRequest}
            searchHost={mainSearchHost}
            mobile={mobile}
            mobileSession={mobileSession}
            visible={visible && !targetPending}
            onSizes={(groupId, splitId, sizes) =>
              setLayout((old) => resizeSplit(old, groupId, splitId, sizes))
            }
            events={{
              actions: register,
              capabilities: reportCapabilities,
              focus,
              close,
            }}
          />
        )}
        {!(mobile ? selected : members.length) && !targetPending && (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {sessions.length > 0 || opened.size > 0 ? picker("label") : newButtons(true)}
          </div>
        )}
      </div>
      {action && (
        <SessionDialog
          key={`${action.kind}:${action.session.id}`}
          action={action}
          identity={name(action.session.id)}
          mutationDisabled={!enabled}
          busy={remote.busy}
          error={remote.mutationError}
          workspace={workspace}
          onClose={() => setAction(undefined)}
          onChange={remote.change}
        />
      )}
      {settings && <TerminalSettings device={device} onClose={() => setSettings(false)} />}
    </>
  );
}
