import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { SquareTerminal } from "lucide-react";
import { members, type MemberPosition, type TerminalGroup, type TerminalLayout } from "./groups";

type Target = { groupId?: string; position?: MemberPosition; key: string };
export function memberTarget(
  event: DragEvent,
  group: TerminalGroup,
  id: string,
  horizontal = true,
): Target {
  const bounds = event.currentTarget.getBoundingClientRect();
  const after = horizontal
    ? event.clientX > bounds.left + bounds.width / 2
    : event.clientY > bounds.top + bounds.height / 2;
  return {
    groupId: group.id,
    position: { anchor: id, side: after ? "after" : "before" },
    key: `${id}:${after ? "after" : "before"}`,
  };
}
export function useTerminalDrag(
  enabled: boolean,
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
    if (!enabled) return;
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
}: {
  layout: TerminalLayout;
  name(id: string): string;
  canDrag(id: string): boolean;
  drag: ReturnType<typeof useTerminalDrag>;
  onSelect(id: string): void;
}) {
  const { t } = useTranslation();

  if (!layout.groups.length) return null;
  return (
    <div className="terminal-groups scroll-area flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {layout.groups.map((group, index) => {
        const target = { groupId: group.id, key: group.id };
        return (
          <div
            key={group.id}
            className="terminal-group flex shrink-0 items-center rounded border"
            data-current={group.id === layout.current}
            data-drop={drag.target?.key === group.id}
            aria-label={t(($) => $.terminal.group, { number: index + 1 })}
            onDragOver={(event) => drag.over(event, target)}
            onDrop={(event) => drag.drop(event, target)}
          >
            {members(group).map((id) => {
              return (
                <button
                  key={id}
                  type="button"
                  className="terminal-member flex min-h-7 max-w-44 items-center gap-1.5 px-2 text-xs max-[959px]:min-h-11 max-[959px]:min-w-11"
                  data-selected={group.id === layout.current && id === group.active}
                  data-drop-before={drag.target?.key === `${id}:before`}
                  data-drop-after={drag.target?.key === `${id}:after`}
                  onClick={() => onSelect(id)}
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
                  <SquareTerminal size={13} className="shrink-0" />
                  <span className="truncate">{name(id)}</span>
                </button>
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
