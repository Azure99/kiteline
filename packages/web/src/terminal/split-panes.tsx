import { useTranslation } from "react-i18next";
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { TerminalActions, TerminalCapabilities } from "./terminal-view";
import { TerminalView } from "./lazy-terminal-view";
import { members, type TerminalGroup, type TerminalNode } from "./groups";

const dividerSize = 4;

interface PaneEvents {
  actions(id: string, value: TerminalActions | null): void;
  capabilities(id: string, value: TerminalCapabilities | undefined): void;
  focus(id: string): void;
  close(id: string): void;
}
export function SplitPanes({
  deviceId,
  deviceName,
  workspaceId,
  workspacePath,
  name,
  groups,
  current,
  opened,
  missing,
  revealRequest,
  searchHost,
  mobile,
  mobileSession,
  visible,
  events,
  onSizes,
}: {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspacePath: string;
  name(id: string): string;
  groups: TerminalGroup[];
  current?: string;
  opened: ReadonlySet<string>;
  /** Opened sessions that a successful session list no longer contains. */
  missing: ReadonlySet<string>;
  revealRequest: RefObject<string | undefined>;
  searchHost: HTMLDivElement | null;
  mobile: boolean;
  mobileSession?: string;
  visible: boolean;
  events: PaneEvents;
  onSizes(groupId: string, splitId: string, sizes: Record<string, number>): void;
}) {
  const { t } = useTranslation();
  const surface = useRef<HTMLDivElement>(null);
  const panes = useRef(new Map<string, HTMLDivElement>());
  const frame = useRef(0);
  const group = groups.find((item) => item.id === current);
  const active = mobile ? mobileSession : group?.active;
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
  useLayoutEffect(() => {
    const id = revealRequest.current;
    if (!id) return;
    if (mobile || !visible || group?.active !== id) {
      revealRequest.current = undefined;
      return;
    }
    const element = surface.current;
    const pane = panes.current.get(id);
    if (!element || !pane || !element.clientWidth || !element.clientHeight) return;
    const scroll = element.parentElement!;
    const viewport = scroll.getBoundingClientRect();
    const left = viewport.left + scroll.clientLeft;
    const top = viewport.top + scroll.clientTop;
    const bounds = pane.getBoundingClientRect();
    function nearestOffset(start: number, end: number, viewStart: number, viewEnd: number) {
      const fits = end - start <= viewEnd - viewStart;
      if (start < viewStart) {
        if (end > viewEnd) return 0;
        return fits ? start - viewStart : end - viewEnd;
      }
      if (end > viewEnd) return fits ? end - viewEnd : start - viewStart;
      return 0;
    }
    revealRequest.current = undefined;
    scroll.scrollLeft += nearestOffset(bounds.left, bounds.right, left, left + scroll.clientWidth);
    scroll.scrollTop += nearestOffset(bounds.top, bounds.bottom, top, top + scroll.clientHeight);
  });
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
    <div className={active ? "scroll-area min-h-0 flex-1 overflow-auto" : "hidden"}>
      <div
        ref={surface}
        className="relative h-full min-h-full"
        style={{ minWidth: minimum.width, minHeight: minimum.height }}
      >
        {active &&
          (single ? (
            <div className="h-full w-full" data-layout-session={active} />
          ) : group ? (
            skeleton(group.root)
          ) : null)}
        {/* Display siblings stay in opening order; only the empty layout skeleton is reparented. */}
        {[...opened].map((id) => {
          const owner = groups.find((item) => members(item).includes(id));
          const shown =
            visible &&
            (mobile
              ? id === mobileSession
              : !!owner && owner === group && (!single || id === active));
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
              <TerminalPane
                id={id}
                sessionName={name(id)}
                deviceId={deviceId}
                deviceName={deviceName}
                workspaceId={workspaceId}
                workspacePath={workspacePath}
                active={id === active}
                hidden={!shown}
                missing={missing.has(id)}
                searchHost={searchHost}
                events={events}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function minimumSize(node: TerminalNode): { width: number; height: number } {
  if ("sessionId" in node) return { width: 180, height: 120 };
  const total = node.children.reduce((sum, child) => sum + node.sizes[child.id]!, 0);
  const children = node.children.map((child) => ({
    minimum: minimumSize(child),
    ratio: node.sizes[child.id]! / total,
  }));
  const splitMinimum = (axis: "width" | "height") => {
    const separators = dividerSize * (children.length - 1);
    // Saved zero shares continue to use the existing panel constraints.
    if (node.children.some((child) => node.sizes[child.id] === 0)) {
      return children.reduce((total, child) => total + child.minimum[axis], separators);
    }
    return Math.max(...children.map((child) => child.minimum[axis] / child.ratio)) + separators;
  };
  const max = (axis: "width" | "height") =>
    Math.max(...children.map((child) => child.minimum[axis]));
  return node.direction === "horizontal"
    ? { width: splitMinimum("width"), height: max("height") }
    : { width: max("width"), height: splitMinimum("height") };
}

function TerminalPane({
  id,
  sessionName,
  deviceId,
  deviceName,
  workspaceId,
  workspacePath,
  active,
  hidden,
  missing,
  searchHost,
  events,
}: {
  id: string;
  sessionName: string;
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspacePath: string;
  active: boolean;
  hidden: boolean;
  missing: boolean;
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
        deviceName={deviceName}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        sessionId={id}
        sessionName={sessionName}
        sessionMissing={missing}
        onClose={() => events.close(id)}
        searchHost={searchHost}
        paneActive={active && !hidden}
      />
    </div>
  );
}
