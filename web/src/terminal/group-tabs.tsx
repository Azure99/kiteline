import { useTranslation } from "react-i18next";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Maximize2, SquareTerminal } from "lucide-react";
import { members, type MemberPosition, type TerminalGroup, type TerminalLayout } from "./groups";

type Target = { groupId?: string; position?: MemberPosition; key: string };
function memberTarget(event: DragEvent, group: TerminalGroup, id: string): Target {
  const bounds = event.currentTarget.getBoundingClientRect();
  const after = event.clientX > bounds.left + bounds.width / 2;
  return {
    groupId: group.id,
    position: { anchor: id, side: after ? "after" : "before" },
    key: `${id}:${after ? "after" : "before"}`,
  };
}
export function useTerminalDrag(
  move: (id: string, groupId?: string, position?: MemberPosition) => void,
) {
  const id = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<Target>();
  function end() {
    id.current = undefined;
    setDragging(false);
    setTarget(undefined);
  }
  function start(event: DragEvent, sessionId: string) {
    id.current = sessionId;
    event.dataTransfer.setData("text/plain", sessionId);
    event.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }
  function over(event: DragEvent, next: Target) {
    if (!id.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setTarget(next);
  }
  function drop(event: DragEvent, next: Target) {
    if (!id.current) return;
    event.preventDefault();
    const sessionId = id.current;
    end();
    move(sessionId, next.groupId, next.position);
  }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") end();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  return { dragging, target, start, end, over, drop };
}
export function GroupTabs({
  layout,
  name,
  canDrag,
  drag,
  onSelect,
  objectMenu,
}: {
  layout: TerminalLayout;
  name(id: string): string;
  canDrag(id: string): boolean;
  drag: ReturnType<typeof useTerminalDrag>;
  onSelect(id: string, keyboard: boolean): void;
  objectMenu(id: string, trigger: ReactElement): ReactNode;
}) {
  const { t } = useTranslation();
  const strip = useRef<HTMLDivElement>(null);
  const active = layout.groups.find((group) => group.id === layout.current)?.active;
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () => {
      const tab = element.querySelector('[data-selected="true"]');
      if (!tab || !element.clientWidth) return;
      const box = element.getBoundingClientRect();
      const current = tab.getBoundingClientRect();
      if (current.width > box.width || current.left < box.left)
        element.scrollLeft += current.left - box.left;
      else if (current.right > box.right) element.scrollLeft += current.right - box.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div
      ref={strip}
      className="terminal-groups scroll-area flex min-w-0 shrink items-center gap-2 overflow-x-auto"
    >
      {layout.groups
        .filter((group) => !group.hidden)
        .map((group) => {
          const index = layout.groups.indexOf(group);
          const target = { groupId: group.id, key: group.id };
          return (
            <div
              key={group.id}
              className="terminal-group flex shrink-0 items-center rounded border"
              data-drop={drag.target?.key === group.id}
              aria-label={t(($) => $.terminal.group, { number: index + 1 })}
              onDragOver={(event) => drag.over(event, target)}
              onDrop={(event) => drag.drop(event, target)}
            >
              {members(group).map((id) => {
                return (
                  <Fragment key={id}>
                    {objectMenu(
                      id,
                      <button
                        type="button"
                        className="terminal-member flex min-h-7 max-w-44 items-center gap-1.5 px-2 text-xs max-desk:min-h-11 max-desk:min-w-11"
                        data-selected={group.id === layout.current && id === group.active}
                        aria-pressed={id === active}
                        aria-label={
                          group.maximized && id === group.active
                            ? `${name(id)} · ${t(($) => $.terminal.maximized)}`
                            : name(id)
                        }
                        data-drop-before={drag.target?.key === `${id}:before`}
                        data-drop-after={drag.target?.key === `${id}:after`}
                        onClick={(event) => onSelect(id, event.detail === 0)}
                        draggable={canDrag(id)}
                        onDragStart={(event) => drag.start(event, id)}
                        onDragEnd={drag.end}
                        onDragOver={(event) => {
                          event.stopPropagation();
                          drag.over(event, memberTarget(event, group, id));
                        }}
                        onDrop={(event) => {
                          event.stopPropagation();
                          drag.drop(event, memberTarget(event, group, id));
                        }}
                        title={name(id)}
                      >
                        {group.maximized && id === group.active ? (
                          <Maximize2 size={13} className="shrink-0" />
                        ) : (
                          <SquareTerminal size={13} className="shrink-0" />
                        )}
                        <span className="truncate">{name(id)}</span>
                      </button>,
                    )}
                  </Fragment>
                );
              })}
            </div>
          );
        })}
      {drag.dragging && (
        <div
          className="terminal-new-group shrink-0 rounded border border-dashed px-3 py-1.5 text-xs"
          data-drop={drag.target?.key === "new"}
          onDragOver={(event) => drag.over(event, { key: "new" })}
          onDrop={(event) => drag.drop(event, { key: "new" })}
        >
          {t(($) => $.terminal.newGroup)}
        </div>
      )}
    </div>
  );
}
