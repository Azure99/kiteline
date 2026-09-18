export interface TerminalGroup {
  id: string;
  members: string[];
  active: string;
  direction: "horizontal" | "vertical";
  sizes: Record<string, number>;
  maximized: boolean;
}
export interface TerminalLayout {
  groups: TerminalGroup[];
  current?: string;
  dock?: string;
  dockOpen: boolean;
  dockSize: number;
}
export function emptyLayout(): TerminalLayout {
  return { groups: [], dockOpen: false, dockSize: 32 };
}
export function groupFor(layout: TerminalLayout, sessionId: string) {
  return layout.groups.find((group) => group.members.includes(sessionId));
}
export function currentGroup(layout: TerminalLayout) {
  return layout.groups.find((group) => group.id === layout.current);
}
function newGroup(sessionId: string): TerminalGroup {
  return {
    id: crypto.randomUUID(),
    members: [sessionId],
    active: sessionId,
    direction: "horizontal",
    sizes: { [sessionId]: 100 },
    maximized: false,
  };
}
function remove(group: TerminalGroup, id: string) {
  group.members = group.members.filter((member) => member !== id);
  delete group.sizes[id];
  const total = Object.values(group.sizes).reduce((sum, size) => sum + size, 0);
  for (const member of group.members)
    group.sizes[member] = total ? (group.sizes[member]! / total) * 100 : 100 / group.members.length;
  if (group.active === id) group.active = group.members[0] ?? "";
  group.maximized = false;
}
function removeEmpty(layout: TerminalLayout) {
  layout.groups = layout.groups.filter((group) => group.members.length);
  if (!currentGroup(layout)) layout.current = undefined;
}
export function selectSession(layout: TerminalLayout, id: string): TerminalLayout {
  const next = structuredClone(layout);
  let group = groupFor(next, id);
  if (!group) {
    group = newGroup(id);
    next.groups.push(group);
  }
  group.active = id;
  next.current = group.id;
  return next;
}
export function closeSession(layout: TerminalLayout, id: string): TerminalLayout {
  const next = structuredClone(layout);
  const group = groupFor(next, id);
  if (group) remove(group, id);
  removeEmpty(next);
  return next;
}
export function moveSession(
  layout: TerminalLayout,
  id: string,
  targetId?: string,
  beforeId?: string,
): TerminalLayout {
  const next = structuredClone(layout);
  const source = groupFor(next, id);
  let target = next.groups.find((group) => group.id === targetId);
  if (targetId && !target) return layout;
  if (source === target && target) {
    if (beforeId === id) return layout;
    target.members = target.members.filter((member) => member !== id);
    const index = beforeId ? target.members.indexOf(beforeId) : target.members.length;
    target.members.splice(index < 0 ? target.members.length : index, 0, id);
  } else {
    if (source) remove(source, id);
    if (!target) {
      target = newGroup(id);
      next.groups.push(target);
    } else {
      const index = beforeId ? target.members.indexOf(beforeId) : target.members.length;
      target.members.splice(index < 0 ? target.members.length : index, 0, id);
      const size = 100 / target.members.length;
      target.sizes = Object.fromEntries(target.members.map((member) => [member, size]));
    }
  }
  target.active = id;
  target.maximized = false;
  next.current = target.id;
  removeEmpty(next);
  return next;
}
export function retainSessions(
  layout: TerminalLayout,
  ids: ReadonlySet<string>,
  dockIds = ids,
): TerminalLayout {
  const stale = layout.groups.flatMap((group) => group.members).filter((id) => !ids.has(id));
  if (!stale.length && (!layout.dock || dockIds.has(layout.dock))) return layout;
  const next = structuredClone(layout);
  for (const group of next.groups)
    for (const id of stale) if (group.members.includes(id)) remove(group, id);
  if (next.dock && !dockIds.has(next.dock)) next.dock = undefined;
  removeEmpty(next);
  return next;
}
