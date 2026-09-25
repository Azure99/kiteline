import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator, type GroupImperativeHandle } from "react-resizable-panels";
import { Maximize2, SquareTerminal, X } from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { TerminalView, type TerminalActions } from "./terminal-view";
import type { TerminalGroup } from "./groups";
import { memberTarget, type useTerminalDrag } from "./group-tabs";

export interface PaneEvents {
  actions(id: string, value: TerminalActions | null): void;
  focus(id: string): void;
  close(id: string): void;
  maximize(): void;
  menu(id: string): ReactNode;
  drag: ReturnType<typeof useTerminalDrag>;
}
export function SplitPanes({
  deviceId,
  workspaceId,
  groups,
  current,
  opened,
  sessions,
  mobile,
  visible,
  events,
  onSizes,
}: {
  deviceId: string;
  workspaceId: string;
  groups: TerminalGroup[];
  current?: string;
  opened: ReadonlySet<string>;
  sessions: Session[];
  mobile: boolean;
  visible: boolean;
  events: PaneEvents;
  onSizes(sizes: Record<string, number>): void;
}) {
  const { t } = useTranslation();

  const panels = useRef<GroupImperativeHandle>(null);
  const group = groups.find((item) => item.id === current);
  const members = group?.members ?? [];
  const direction = group?.direction ?? "horizontal";
  const allMembers = groups.flatMap((item) => item.members);
  const single = mobile || !!group?.maximized;
  const layout = Object.fromEntries(
    allMembers.map((id) => [
      id,
      !group || !members.includes(id)
        ? 0
        : single
          ? id === group.active
            ? 100
            : 0
          : (group.sizes[id] ?? 100 / members.length),
    ]),
  );
  const layoutKey = JSON.stringify(layout);
  useLayoutEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const sizes = JSON.parse(layoutKey) as Record<string, number>;
      const order = Object.keys(panels.current?.getLayout() ?? {});
      // The component applies constraints in its registered order, including hidden panels.
      if (order.length)
        panels.current?.setLayout(Object.fromEntries(order.map((id) => [id, sizes[id]!])));
    });
    return () => cancelAnimationFrame(frame);
  }, [layoutKey, direction, visible]);
  return (
    <div className={group ? "scroll-area min-h-0 flex-1 overflow-auto" : "hidden"}>
      <Group
        // Re-register layout order without remounting the keyed terminal panels.
        id={`terminal-${workspaceId}-${allMembers.join(":")}`}
        groupRef={panels}
        orientation={direction}
        disabled={single}
        className="h-full min-h-full"
        style={{
          minWidth: !single && direction === "horizontal" ? members.length * 180 : undefined,
          minHeight: !single && direction === "vertical" ? members.length * 120 : undefined,
        }}
        onLayoutChanged={(sizes, meta) => {
          if (meta.isUserInteraction && !single)
            onSizes(Object.fromEntries(members.map((id) => [id, sizes[id]!])));
        }}
      >
        {allMembers.flatMap((id) => {
          const owner = groups.find((item) => item.members.includes(id))!;
          const shown = owner === group && (!single || id === group.active);
          const divider = shown && !single && members.indexOf(id) > 0;
          return [
            divider && (
              <Separator
                key={`divider:${id}`}
                className="split-divider"
                aria-label={t(($) => $.terminal.resize)}
              />
            ),
            <Panel
              key={id}
              id={id}
              minSize={!shown || single ? 0 : direction === "horizontal" ? 180 : 120}
              maxSize={shown ? "100%" : "0%"}
              defaultSize={`${layout[id]}%`}
              className="flex h-full min-h-0 min-w-0 flex-col"
            >
              {opened.has(id) && (
                <TerminalPane
                  key={id}
                  id={id}
                  deviceId={deviceId}
                  workspaceId={workspaceId}
                  session={sessions.find((session) => session.id === id)}
                  active={id === owner.active}
                  group={owner}
                  showHeader={!mobile && !owner.maximized && owner.members.length > 1}
                  hidden={!shown}
                  events={events}
                />
              )}
            </Panel>,
          ];
        })}
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
  group,
  showHeader,
  hidden,
  events,
}: {
  id: string;
  deviceId: string;
  workspaceId: string;
  session?: Session;
  active: boolean;
  group: TerminalGroup;
  showHeader: boolean;
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
      {showHeader && (
        <header
          className="terminal-pane-header flex min-h-8 shrink-0 items-center gap-1 px-2"
          data-direction={group.direction}
          data-drop-before={events.drag.target?.key === `${id}:before`}
          data-drop-after={events.drag.target?.key === `${id}:after`}
          onDragOver={(event) =>
            events.drag.over(
              event,
              memberTarget(event, group, id, group.direction === "horizontal"),
            )
          }
          onDrop={(event) =>
            events.drag.drop(
              event,
              memberTarget(event, group, id, group.direction === "horizontal"),
            )
          }
        >
          <button
            draggable
            onDragStart={(event) => events.drag.start(event, id)}
            onDragEnd={events.drag.end}
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
          <IconButton label={t(($) => $.terminal.maximize)} onClick={events.maximize}>
            <Maximize2 />
          </IconButton>
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
      )}
      <TerminalView ref={actions} deviceId={deviceId} workspaceId={workspaceId} sessionId={id} />
    </div>
  );
}
