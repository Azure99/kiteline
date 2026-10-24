import { useTranslation } from "react-i18next";
import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { TerminalActions, TerminalCapabilities } from "./terminal-view";
import { TerminalView } from "./lazy-terminal-view";
import { members, type TerminalGroup, type TerminalNode } from "./groups";

export interface PaneEvents {
  actions(id: string, value: TerminalActions | null): void;
  capabilities(id: string, value: TerminalCapabilities | undefined): void;
  focus(id: string): void;
}
export function SplitPanes({
  deviceId,
  workspaceId,
  workspacePath,
  groups,
  current,
  opened,
  searchHost,
  mobile,
  visible,
  events,
  onSizes,
}: {
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  groups: TerminalGroup[];
  current?: string;
  opened: ReadonlySet<string>;
  searchHost: HTMLDivElement | null;
  mobile: boolean;
  visible: boolean;
  events: PaneEvents;
  onSizes(groupId: string, splitId: string, sizes: Record<string, number>): void;
}) {
  const { t } = useTranslation();
  const surface = useRef<HTMLDivElement>(null);
  const panes = useRef(new Map<string, HTMLDivElement>());
  const frame = useRef(0);
  const group = groups.find((item) => item.id === current);
  const single = mobile || !!group?.maximized;
  const minimum = group && !single ? minimumSize(group.root) : { width: 0, height: 0 };
  const measure = useCallback(() => {
    const element = surface.current;
    if (!element || !element.clientWidth || !element.clientHeight) return;
    const origin = element.getBoundingClientRect();
    for (const leaf of element.querySelectorAll<HTMLElement>("[data-layout-session]")) {
      const pane = panes.current.get(leaf.dataset.layoutSession!);
      if (!pane) continue;
      const rect = leaf.getBoundingClientRect();
      Object.assign(pane.style, {
        left: `${rect.left - origin.left}px`,
        top: `${rect.top - origin.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }
  }, []);
  const scheduleMeasure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  }, [measure]);
  useLayoutEffect(() => {
    const element = surface.current;
    if (single || !visible || !element) return;
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(element);
    element.querySelectorAll("[data-layout-session]").forEach((leaf) => observer.observe(leaf));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [group, single, opened, visible, measure, scheduleMeasure]);
  function skeleton(node: TerminalNode): ReactNode {
    if ("sessionId" in node)
      return <div className="h-full w-full" data-layout-session={node.sessionId} />;
    return (
      <Group
        key={`${node.id}:${node.children.map((child) => child.id).join(":")}`}
        id={node.id}
        orientation={node.direction}
        defaultLayout={node.sizes}
        className="h-full w-full"
        onLayoutChange={scheduleMeasure}
        onLayoutChanged={(sizes, meta) => {
          if (meta.isUserInteraction && group) onSizes(group.id, node.id, sizes);
        }}
      >
        {node.children.flatMap((child, index) => [
          index > 0 && (
            <Separator
              key={`divider:${child.id}`}
              className="split-divider terminal-divider"
              aria-label={t(($) => $.terminal.resize)}
            />
          ),
          <Panel
            key={child.id}
            id={child.id}
            defaultSize={`${node.sizes[child.id]}%`}
            minSize={minimumSize(child)[node.direction === "horizontal" ? "width" : "height"]}
          >
            {skeleton(child)}
          </Panel>,
        ])}
      </Group>
    );
  }
  return (
    <div className={group ? "scroll-area min-h-0 flex-1 overflow-auto" : "hidden"}>
      <div
        ref={surface}
        className="relative h-full min-h-full"
        style={{ minWidth: minimum.width, minHeight: minimum.height }}
      >
        {group &&
          (single ? (
            <div className="h-full w-full" data-layout-session={group.active} />
          ) : (
            skeleton(group.root)
          ))}
        {/* Display siblings stay in opening order; only the empty layout skeleton is reparented. */}
        {[...opened].map((id) => {
          const owner = groups.find((item) => members(item).includes(id));
          const shown = !!owner && owner === group && visible && (!single || id === group.active);
          return (
            <div
              key={id}
              ref={(element) => {
                if (element) panes.current.set(id, element);
                else panes.current.delete(id);
              }}
              hidden={!shown}
              className="absolute flex min-h-0 min-w-0 flex-col"
              style={
                single
                  ? { left: 0, top: 0, width: "100%", height: "100%" }
                  : { width: 0, height: 0 }
              }
            >
              {owner && (
                <TerminalPane
                  id={id}
                  deviceId={deviceId}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                  active={id === owner.active}
                  hidden={!shown}
                  searchHost={searchHost}
                  events={events}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function minimumSize(node: TerminalNode): { width: number; height: number } {
  if ("sessionId" in node) return { width: 180, height: 120 };
  const children = node.children.map(minimumSize);
  const sum = (axis: "width" | "height") =>
    children.reduce((total, child) => total + child[axis], 4 * (children.length - 1));
  const max = (axis: "width" | "height") => Math.max(...children.map((child) => child[axis]));
  return node.direction === "horizontal"
    ? { width: sum("width"), height: max("height") }
    : { width: max("width"), height: sum("height") };
}

function TerminalPane({
  id,
  deviceId,
  workspaceId,
  workspacePath,
  active,
  hidden,
  searchHost,
  events,
}: {
  id: string;
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  active: boolean;
  hidden: boolean;
  searchHost: HTMLDivElement | null;
  events: PaneEvents;
}) {
  const register = events.actions;
  const setActions = useCallback(
    (value: TerminalActions | null) => {
      register(id, value);
    },
    [id, register],
  );
  return (
    <div
      className={hidden ? "hidden" : "terminal-pane flex min-h-0 min-w-0 flex-1 flex-col"}
      data-session-id={id}
      onPointerDown={() => events.focus(id)}
      onFocusCapture={() => events.focus(id)}
    >
      <TerminalView
        ref={setActions}
        onCapabilities={events.capabilities}
        deviceId={deviceId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        sessionId={id}
        searchHost={searchHost}
        searchActive={active && !hidden}
      />
    </div>
  );
}
