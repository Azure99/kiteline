export type SplitDirection = "horizontal" | "vertical";
export interface TerminalLeaf {
  id: string;
  sessionId: string;
}
export interface TerminalSplit {
  id: string;
  direction: SplitDirection;
  children: TerminalNode[];
  sizes: Record<string, number>;
}
export type TerminalNode = TerminalLeaf | TerminalSplit;
export interface TerminalGroup {
  id: string;
  root: TerminalNode;
  active: string;
  maximized: boolean;
}
export interface TerminalLayout {
  groups: TerminalGroup[];
  current?: string;
  dock?: string;
  dockOpen: boolean;
  dockSize: number;
}
export interface MemberPosition {
  anchor: string;
  side: "before" | "after";
}
export function emptyLayout(): TerminalLayout {
  return { groups: [], dockOpen: false, dockSize: 32 };
}
export function leaves(node: TerminalNode): TerminalLeaf[] {
  return "sessionId" in node ? [node] : node.children.flatMap(leaves);
}
export function members(group: TerminalGroup): string[] {
  return leaves(group.root).map((leaf) => leaf.sessionId);
}
export function groupFor(layout: TerminalLayout, sessionId: string) {
  return layout.groups.find((group) => members(group).includes(sessionId));
}
export function currentGroup(layout: TerminalLayout) {
  return layout.groups.find((group) => group.id === layout.current);
}
export function parentSplit(node: TerminalNode, sessionId: string): TerminalSplit | undefined {
  if ("sessionId" in node) return undefined;
  if (node.children.some((child) => "sessionId" in child && child.sessionId === sessionId))
    return node;
  for (const child of node.children) {
    const parent = parentSplit(child, sessionId);
    if (parent) return parent;
  }
  return undefined;
}
function leaf(sessionId: string): TerminalLeaf {
  return { id: crypto.randomUUID(), sessionId };
}
function branch(direction: SplitDirection, children: TerminalNode[]): TerminalSplit {
  return {
    id: crypto.randomUUID(),
    direction,
    children,
    sizes: Object.fromEntries(children.map((child) => [child.id, 100 / children.length])),
  };
}
function newGroup(sessionId: string): TerminalGroup {
  return { id: crypto.randomUUID(), root: leaf(sessionId), active: sessionId, maximized: false };
}
function insert(
  node: TerminalNode,
  added: TerminalLeaf,
  position: MemberPosition,
  direction: SplitDirection,
): TerminalNode {
  if ("sessionId" in node)
    return node.sessionId === position.anchor
      ? branch(direction, position.side === "before" ? [added, node] : [node, added])
      : node;
  const index = node.children.findIndex(
    (child) => "sessionId" in child && child.sessionId === position.anchor,
  );
  if (index >= 0 && node.direction === direction) {
    const anchor = node.children[index]!;
    const half = node.sizes[anchor.id]! / 2;
    node.sizes[anchor.id] = half;
    node.sizes[added.id] = half;
    node.children.splice(index + (position.side === "after" ? 1 : 0), 0, added);
  } else
    node.children = node.children.map((child) => {
      const next = insert(child, added, position, direction);
      if (next.id !== child.id) {
        node.sizes[next.id] = node.sizes[child.id]!;
        delete node.sizes[child.id];
      }
      return next;
    });
  return node;
}
function removeNode(node: TerminalNode, sessionId: string): TerminalNode | undefined {
  if ("sessionId" in node) return node.sessionId === sessionId ? undefined : node;
  const children = node.children.flatMap((child) => {
    const next = removeNode(child, sessionId);
    if (next && next.id !== child.id) node.sizes[next.id] = node.sizes[child.id]!;
    return next ? [next] : [];
  });
  if (children.length < 2) return children[0];
  const total = children.reduce((sum, child) => sum + node.sizes[child.id]!, 0);
  node.sizes = Object.fromEntries(
    children.map((child) => [child.id, (node.sizes[child.id]! / total) * 100]),
  );
  node.children = children;
  return node;
}
function remove(layout: TerminalLayout, group: TerminalGroup, id: string) {
  const root = removeNode(group.root, id);
  if (!root) layout.groups = layout.groups.filter((item) => item !== group);
  else {
    group.root = root;
    if (group.active === id) group.active = leaves(root)[0]!.sessionId;
    group.maximized = false;
  }
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
  if (group) remove(next, group, id);
  return next;
}
export function splitSession(
  layout: TerminalLayout,
  id: string,
  groupId: string,
  anchor: string,
  direction: SplitDirection,
): TerminalLayout {
  const next = structuredClone(layout);
  const target = next.groups.find((group) => group.id === groupId);
  if (!target || !members(target).includes(anchor)) return selectSession(layout, id);
  const source = groupFor(next, id);
  if (source) remove(next, source, id);
  target.root = insert(target.root, leaf(id), { anchor, side: "after" }, direction);
  target.active = id;
  target.maximized = false;
  next.current = target.id;
  return next;
}
export function moveSession(
  layout: TerminalLayout,
  id: string,
  targetId?: string,
  position?: MemberPosition,
): TerminalLayout {
  const next = structuredClone(layout);
  const source = groupFor(next, id);
  let target = next.groups.find((group) => group.id === targetId);
  if (targetId && (!target || (position && !members(target).includes(position.anchor))))
    return layout;
  if (source === target && target) {
    if (!position || position.anchor === id) return layout;
    const slots = leaves(target.root);
    const order = slots.map((item) => item.sessionId).filter((member) => member !== id);
    order.splice(order.indexOf(position.anchor) + (position.side === "after" ? 1 : 0), 0, id);
    slots.forEach((slot, index) => {
      slot.sessionId = order[index]!;
    });
  } else {
    if (source) remove(next, source, id);
    if (!target) {
      target = newGroup(id);
      next.groups.push(target);
    } else {
      const placement = position ?? { anchor: target.active, side: "after" };
      const direction = position
        ? (parentSplit(target.root, position.anchor)?.direction ?? "horizontal")
        : "horizontal";
      target.root = insert(target.root, leaf(id), placement, direction);
    }
  }
  target.active = id;
  target.maximized = false;
  next.current = target.id;
  return next;
}
export function arrangeGroup(
  layout: TerminalLayout,
  groupId: string,
  direction: SplitDirection,
): TerminalLayout {
  const next = structuredClone(layout);
  const group = next.groups.find((item) => item.id === groupId);
  if (group) {
    const slots = leaves(group.root);
    group.root = slots.length === 1 ? slots[0]! : branch(direction, slots);
    group.maximized = false;
  }
  return next;
}
export function resizeSplit(
  layout: TerminalLayout,
  groupId: string,
  splitId: string,
  sizes: Record<string, number>,
): TerminalLayout {
  const next = structuredClone(layout);
  const group = next.groups.find((item) => item.id === groupId);
  function resize(node: TerminalNode) {
    if ("sessionId" in node) return;
    if (node.id === splitId) node.sizes = sizes;
    else node.children.forEach(resize);
  }
  if (group) resize(group.root);
  return next;
}
export function retainSessions(
  layout: TerminalLayout,
  ids: ReadonlySet<string>,
  dockIds = ids,
): TerminalLayout {
  const stale = layout.groups.flatMap(members).filter((id) => !ids.has(id));
  if (!stale.length && (!layout.dock || dockIds.has(layout.dock))) return layout;
  const next = structuredClone(layout);
  for (const id of stale) {
    const group = groupFor(next, id);
    if (group) remove(next, group, id);
  }
  if (next.dock && !dockIds.has(next.dock)) next.dock = undefined;
  return next;
}
