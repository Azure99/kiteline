import type { TerminalGroup, TerminalLayout, TerminalNode } from "./groups";

export const terminalLayoutsKey = "kiteline.terminalLayouts";

function invalid(): never {
  throw new Error("Invalid saved terminal layout");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalid();
}
function percentage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : invalid();
}
function layout(value: unknown): TerminalLayout {
  const saved = object(value);
  const nodeIds = new Set<string>();
  const sessionIds = new Set<string>();
  function node(value: unknown, members: Set<string>): TerminalNode {
    const saved = object(value);
    const key = id(saved.id);
    if (nodeIds.has(key)) return invalid();
    nodeIds.add(key);
    if ("sessionId" in saved) {
      const sessionId = id(saved.sessionId);
      if (sessionIds.has(sessionId)) return invalid();
      sessionIds.add(sessionId);
      members.add(sessionId);
      return { id: key, sessionId };
    }
    if (
      (saved.direction !== "horizontal" && saved.direction !== "vertical") ||
      !Array.isArray(saved.children) ||
      saved.children.length < 2
    )
      return invalid();
    const children = saved.children.map((child) => node(child, members));
    const sizes = object(saved.sizes);
    const entries = children.map((child) => [child.id, percentage(sizes[child.id])] as const);
    if (entries.reduce((total, [, size]) => total + size, 0) <= 0) return invalid();
    return { id: key, direction: saved.direction, children, sizes: Object.fromEntries(entries) };
  }
  if (!Array.isArray(saved.groups)) return invalid();
  const groupIds = new Set<string>();
  const groups: TerminalGroup[] = saved.groups.map((value) => {
    const group = object(value);
    const key = id(group.id);
    if (groupIds.has(key) || typeof group.maximized !== "boolean") return invalid();
    groupIds.add(key);
    const members = new Set<string>();
    const root = node(group.root, members);
    const active = id(group.active);
    if (!members.has(active)) return invalid();
    return { id: key, root, active, maximized: group.maximized };
  });
  const current = saved.current === undefined ? undefined : id(saved.current);
  if (current !== undefined && !groupIds.has(current)) return invalid();
  if (typeof saved.dockOpen !== "boolean") return invalid();
  return {
    groups,
    current,
    dock: saved.dock === undefined ? undefined : id(saved.dock),
    dockOpen: saved.dockOpen,
    dockSize: percentage(saved.dockSize),
  };
}

export function readTerminalLayouts(storage: Pick<Storage, "getItem">) {
  const text = storage.getItem(terminalLayoutsKey);
  const entries: unknown = text === null ? [] : JSON.parse(text);
  if (!Array.isArray(entries)) return invalid();
  const layouts = new Map<string, TerminalLayout>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return invalid();
    const key = id(entry[0]);
    if (layouts.has(key)) return invalid();
    layouts.set(key, layout(entry[1]));
  }
  return layouts;
}

export function writeTerminalLayouts(
  storage: Pick<Storage, "setItem">,
  layouts: Map<string, TerminalLayout>,
) {
  storage.setItem(terminalLayoutsKey, JSON.stringify([...layouts]));
}
