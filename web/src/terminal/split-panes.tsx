import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, type DragEvent, type ReactNode } from "react";
import { Group, Panel, Separator, type GroupImperativeHandle } from "react-resizable-panels";
import { Maximize2, Minimize2, SquareTerminal, X } from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { TerminalView, type TerminalActions } from "./terminal-view";
import type { TerminalGroup } from "./groups";
import type { DisplayState } from "./display";

export interface PaneEvents {
  actions(id: string, value: TerminalActions | null): void;
  status(id: string, status: DisplayState["status"]): void;
  focus(id: string): void;
  close(id: string): void;
  maximize(): void;
  menu(id: string): ReactNode;
  dragStart(event: DragEvent, id: string): void;
  dragEnd(): void;
}
export function SplitPanes({
  deviceId,
  workspaceId,
  group,
  members,
  sessions,
  mobile,
  visible,
  events,
  onSizes,
}: {
  deviceId: string;
  workspaceId: string;
  group: TerminalGroup;
  members: string[];
  sessions: Session[];
  mobile: boolean;
  visible: boolean;
  events: PaneEvents;
  onSizes(sizes: Record<string, number>): void;
}) {
  const { t } = useTranslation();

  const panels = useRef<GroupImperativeHandle>(null);
  const single = mobile || group.maximized;
  const layout = Object.fromEntries(
    members.map((id) => [
      id,
      single ? (id === group.active ? 100 : 0) : (group.sizes[id] ?? 100 / members.length),
    ]),
  );
  const layoutKey = JSON.stringify(layout);
  useLayoutEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() =>
      panels.current?.setLayout(JSON.parse(layoutKey) as Record<string, number>),
    );
    return () => cancelAnimationFrame(frame);
  }, [layoutKey, group.direction, visible]);
  return (
    <div className="scroll-area min-h-0 flex-1 overflow-auto">
      <Group
        id={`terminal-${workspaceId}-${members.join("_")}`}
        groupRef={panels}
        orientation={group.direction}
        disabled={single}
        className="h-full min-h-full"
        style={{
          minWidth: !single && group.direction === "horizontal" ? members.length * 180 : undefined,
          minHeight: !single && group.direction === "vertical" ? members.length * 120 : undefined,
        }}
        onLayoutChanged={(sizes, meta) => {
          if (meta.isUserInteraction && !single) onSizes(sizes);
        }}
      >
        {members.flatMap((id, index) => [
          index > 0 && (
            <Separator
              key={`divider:${id}`}
              disabled={single}
              className={single ? "hidden" : "split-divider"}
              aria-label={t(($) => $.terminal.resize)}
            />
          ),
          <Panel
            key={id}
            id={id}
            minSize={single ? 0 : group.direction === "horizontal" ? 180 : 120}
            maxSize={single && id !== group.active ? "0%" : "100%"}
            defaultSize={`${layout[id]}%`}
            className="flex h-full min-h-0 min-w-0 flex-col"
          >
            {(!mobile || id === group.active) && (
              <TerminalPane
                key={id}
                id={id}
                deviceId={deviceId}
                workspaceId={workspaceId}
                session={sessions.find((session) => session.id === id)}
                active={id === group.active}
                maximized={group.maximized}
                multiple={members.length > 1}
                mobile={mobile}
                hidden={single && id !== group.active}
                events={events}
              />
            )}
          </Panel>,
        ])}
      </Group>
    </div>
  );
}

function TerminalPane({
  id,
  deviceId,
  workspaceId,
  session,
  active,
  maximized,
  multiple,
  mobile,
  hidden,
  events,
}: {
  id: string;
  deviceId: string;
  workspaceId: string;
  session?: Session;
  active: boolean;
  maximized: boolean;
  multiple: boolean;
  mobile: boolean;
  hidden: boolean;
  events: PaneEvents;
}) {
  const { t } = useTranslation();

  const name = useRef(session?.name);
  if (session) name.current = session.name;
  const actions = useRef<TerminalActions>(null);
  const register = events.actions;
  useEffect(() => {
    register(id, actions.current);
    return () => register(id, null);
  }, [id, register]);
  return (
    <div
      className={hidden ? "hidden" : "terminal-pane flex min-h-0 min-w-0 flex-1 flex-col"}
      data-active={active}
      data-session-id={id}
      onPointerDown={() => events.focus(id)}
      onFocusCapture={() => events.focus(id)}
    >
      <header className="terminal-pane-header flex min-h-8 shrink-0 items-center gap-1 px-2 max-[959px]:hidden">
        <button
          draggable={!mobile}
          onDragStart={(event) => events.dragStart(event, id)}
          onDragEnd={events.dragEnd}
          onClick={() => {
            events.focus(id);
            actions.current?.focus();
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
          title={name.current ?? t(($) => $.common.terminal)}
        >
          <SquareTerminal size={13} className="shrink-0" />
          <span className="truncate">{name.current ?? t(($) => $.common.terminal)}</span>
        </button>
        {multiple && (
          <IconButton
            label={maximized ? t(($) => $.terminal.restoreSplit) : t(($) => $.terminal.maximize)}
            onClick={events.maximize}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        )}
        {events.menu(id)}
        <IconButton
          label={t(($) => $.terminal.closeNamed, {
            name: name.current ?? t(($) => $.common.terminal),
          })}
          onClick={() => events.close(id)}
        >
          <X />
        </IconButton>
      </header>
      <TerminalView
        ref={actions}
        deviceId={deviceId}
        workspaceId={workspaceId}
        sessionId={id}
        onStatus={(status) => events.status(id, status)}
      />
    </div>
  );
}
