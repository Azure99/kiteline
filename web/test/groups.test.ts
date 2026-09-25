import { expect, test } from "vitest";
import {
  closeSession,
  currentGroup,
  emptyLayout,
  moveSession,
  retainSessions,
  selectSession,
  members,
  leaves,
  splitSession,
  arrangeGroup,
  resizeSplit,
  parentSplit,
} from "../src/terminal/groups";

test("moving existing sessions preserves identity and removes empty groups", () => {
  let layout = selectSession(emptyLayout(), "build");
  const target = layout.current;
  layout = moveSession(layout, "tests", target);
  layout = moveSession(layout, "shell", target);
  const original = layout;
  layout = moveSession(layout, "shell", target, { anchor: "build", side: "before" });
  expect(members(currentGroup(layout)!)).toEqual(["shell", "build", "tests"]);
  expect(members(currentGroup(original)!)).toEqual(["build", "tests", "shell"]);
  layout = moveSession(layout, "shell");
  expect(layout.groups).toHaveLength(2);
  expect(members(currentGroup(layout)!)).toEqual(["shell"]);
  layout = moveSession(layout, "shell", target);
  expect(layout.groups).toHaveLength(1);
  expect(new Set(members(currentGroup(layout)!))).toEqual(new Set(["shell", "build", "tests"]));
});

test("closing the last display keeps the closed state instead of opening another group", () => {
  const first = selectSession(emptyLayout(), "build");
  const layout = closeSession(selectSession(first, "tests"), "tests");
  expect(layout.current).toBeUndefined();
  expect(members(layout.groups[0]!)).toEqual(["build"]);
  expect(members(currentGroup(selectSession(layout, "tests"))!)).toEqual(["tests"]);
});

test("recursive splits preserve local proportions and collapse only the emptied division", () => {
  let layout = selectSession(emptyLayout(), "A");
  const id = layout.current!;
  layout = splitSession(layout, "B", id, "A", "horizontal");
  const root = currentGroup(layout)!.root;
  if (!("children" in root)) throw Error("missing split");
  const sizes = { [root.children[0]!.id]: 60, [root.children[1]!.id]: 40 };
  layout = resizeSplit(layout, id, root.id, sizes);
  layout = splitSession(layout, "C", id, "B", "vertical");
  layout = splitSession(layout, "D", id, "A", "vertical");
  expect(members(currentGroup(layout)!)).toEqual(["A", "D", "B", "C"]);
  expect(parentSplit(currentGroup(layout)!.root, "C")?.direction).toBe("vertical");
  layout = splitSession(layout, "E", id, "C", "vertical");
  expect(parentSplit(currentGroup(layout)!.root, "B")?.children).toHaveLength(3);
  layout = closeSession(closeSession(layout, "E"), "C");
  expect(parentSplit(currentGroup(layout)!.root, "B")?.id).toBe(root.id);
  const shrunk = currentGroup(layout)!.root;
  if (!("children" in shrunk)) throw Error("missing root split");
  expect(Object.values(shrunk.sizes)).toEqual([60, 40]);
  expect(members(currentGroup(layout)!)).toEqual(["A", "D", "B"]);
});

test("sorting keeps slots, cross-group insertion uses the target parent, and arrange flattens", () => {
  let layout = selectSession(emptyLayout(), "A");
  const id = layout.current!;
  layout = splitSession(layout, "B", id, "A", "horizontal");
  layout = splitSession(layout, "C", id, "B", "vertical");
  const slots = leaves(currentGroup(layout)!.root).map((item) => item.id);
  layout = moveSession(layout, "A", id, { anchor: "C", side: "after" });
  expect(members(currentGroup(layout)!)).toEqual(["B", "C", "A"]);
  expect(leaves(currentGroup(layout)!.root).map((item) => item.id)).toEqual(slots);
  layout = selectSession(layout, "D");
  layout = moveSession(layout, "D", id, { anchor: "C", side: "before" });
  expect(parentSplit(currentGroup(layout)!.root, "D")?.direction).toBe("vertical");
  expect(members(currentGroup(layout)!)).toEqual(["B", "D", "C", "A"]);
  layout = arrangeGroup(layout, id, "horizontal");
  const root = currentGroup(layout)!.root;
  if (!("children" in root)) throw Error("missing split");
  expect(root.children.every((child) => "sessionId" in child)).toBe(true);
  expect(Object.values(root.sizes)).toEqual([25, 25, 25, 25]);
});

test("a completed create falls back to its own group if the original anchor moved", () => {
  let layout = selectSession(emptyLayout(), "A");
  const target = layout.current!;
  layout = splitSession(layout, "B", target, "A", "horizontal");
  layout = moveSession(layout, "A");
  const result = splitSession(layout, "new", target, "A", "vertical");
  expect(members(currentGroup(result)!)).toEqual(["new"]);
  expect(result.groups.find((group) => group.id === target)?.root).toEqual(
    layout.groups.find((group) => group.id === target)?.root,
  );
});

test("selecting a published starting session before create completes does not duplicate it", () => {
  const original = selectSession(emptyLayout(), "anchor");
  const selected = selectSession(original, "starting");
  const result = splitSession(selected, "starting", original.current!, "anchor", "vertical");
  expect(result.groups).toHaveLength(1);
  expect(members(currentGroup(result)!)).toEqual(["anchor", "starting"]);
});

test("a retained companion end screen does not keep a released main group", () => {
  const layout = { ...selectSession(emptyLayout(), "ended"), dock: "ended", dockOpen: true };
  const kept = retainSessions(layout, new Set(), new Set(["ended"]));
  expect(kept.groups).toEqual([]);
  expect(kept.dock).toBe("ended");
  expect(retainSessions(kept, new Set()).dock).toBeUndefined();
});
