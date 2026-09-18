import { useEffect, useRef, useState, type DragEvent } from "react";
import { SquareTerminal } from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import type { TerminalLayout } from "./groups";

type Target = { groupId?: string; before?: string; key: string };
export function useTerminalDrag(
  enabled: boolean,
  move: (id: string, groupId?: string, before?: string) => void,
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
    move(sessionId, next.groupId, next.before);
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
  sessions,
  ended,
  mobile,
  drag,
  onSelect,
}: {
  layout: TerminalLayout;
  sessions: Session[];
  ended: ReadonlySet<string>;
  mobile: boolean;
  drag: ReturnType<typeof useTerminalDrag>;
  onSelect(id: string): void;
}) {
  if (!layout.groups.length) return null;
  return (
    <div className="terminal-groups scroll-area flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-2 py-1.5">
      {layout.groups.map((group, index) => {
        const target = { groupId: group.id, key: group.id };
        return (
          <div
            key={group.id}
            className="terminal-group flex shrink-0 items-center rounded border"
            data-current={group.id === layout.current}
            data-drop={drag.target?.key === group.id}
            aria-label={`第 ${index + 1} 组`}
            onDragOver={(event) => drag.over(event, target)}
            onDrop={(event) => drag.drop(event, target)}
          >
            {group.members.map((id, memberIndex) => {
              const name =
                sessions.find((session) => session.id === id)?.name ??
                (ended.has(id) ? "已结束" : "终端");
              function position(event: DragEvent) {
                const bounds = event.currentTarget.getBoundingClientRect();
                const after = event.clientX > bounds.left + bounds.width / 2;
                return {
                  groupId: group.id,
                  before: after ? group.members[memberIndex + 1] : id,
                  key: `${id}:${after ? "after" : "before"}`,
                };
              }
              return (
                <button
                  key={id}
                  type="button"
                  className="terminal-member flex min-h-7 max-w-44 items-center gap-1.5 px-2 text-xs max-[959px]:min-h-11 max-[959px]:min-w-11"
                  data-selected={group.id === layout.current && id === group.active}
                  data-drop-before={drag.target?.key === `${id}:before`}
                  data-drop-after={drag.target?.key === `${id}:after`}
                  onClick={() => onSelect(id)}
                  draggable={!mobile}
                  onDragStart={(event) => drag.start(event, id)}
                  onDragEnd={drag.end}
                  onDragOver={(event) => {
                    event.stopPropagation();
                    drag.over(event, position(event));
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    drag.drop(event, position(event));
                  }}
                  title={name}
                >
                  <SquareTerminal size={13} className="shrink-0" />
                  <span className="truncate">{name}</span>
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
          独立成组
        </div>
      )}
    </div>
  );
}
