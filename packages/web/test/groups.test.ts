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
  showGroup,
  groupFor,
  placeCreatedSession,
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

test("a completed create can select a new group", () => {
  const original = selectSession(emptyLayout(), "shell");
  const result = placeCreatedSession(original, "created", { activate: true });
  expect(result.groups).toHaveLength(2);
  expect(members(currentGroup(result)!)).toEqual(["created"]);
  expect(currentGroup(original)?.active).toBe("shell");
});

test("an activated split reveals its original group and selects the created session", () => {
  let layout = selectSession(emptyLayout(), "build");
  const target = layout.current!;
  layout = splitSession(layout, "tests", target, "build", "horizontal");
  currentGroup(layout)!.maximized = true;
  layout = showGroup(layout, target, false);
  const original = structuredClone(layout);

  const result = placeCreatedSession(layout, "created", {
    activate: true,
    split: { groupId: target, anchor: "build", direction: "vertical" },
  });
  expect(result.current).toBe(target);
  expect(currentGroup(result)).toMatchObject({ active: "created", maximized: false });
  expect(currentGroup(result)?.hidden).toBeUndefined();
  expect(members(currentGroup(result)!)).toEqual(["build", "created", "tests"]);
  expect(parentSplit(currentGroup(result)!.root, "created")?.direction).toBe("vertical");
  expect(layout).toEqual(original);
});

test("a completed create is placed without replacing a later selection", () => {
  const requested = selectSession(emptyLayout(), "build");
  const selected = selectSession(requested, "shell");
  const result = placeCreatedSession(selected, "created", { activate: false });
  expect(currentGroup(result)?.active).toBe("shell");
  expect(members(groupFor(result, "created")!)).toEqual(["created"]);
  expect(result.groups.flatMap(members)).toEqual(["build", "shell", "created"]);
});

test("an inactive split preserves hidden and maximized groups and their active session", () => {
  let layout = selectSession(emptyLayout(), "build");
  const target = layout.current!;
  layout = splitSession(layout, "tests", target, "build", "horizontal");
  currentGroup(layout)!.maximized = true;
  layout = selectSession(showGroup(layout, target, false), "shell");
  const original = structuredClone(layout);

  const result = placeCreatedSession(layout, "created", {
    activate: false,
    split: { groupId: target, anchor: "build", direction: "vertical" },
  });
  expect(groupFor(result, "created")).toMatchObject({
    id: target,
    active: "tests",
    maximized: true,
    hidden: true,
  });
  expect(members(groupFor(result, "created")!)).toEqual(["build", "created", "tests"]);
  expect(currentGroup(result)?.active).toBe("shell");
  expect(layout).toEqual(original);
});

test.each([false, true])(
  "an inactive create preserves an explicitly empty selection (split=%s)",
  (split) => {
    const anchor = selectSession(emptyLayout(), "build");
    const layout = closeSession(selectSession(anchor, "shell"), "shell");
    const result = placeCreatedSession(layout, "created", {
      activate: false,
      split: split
        ? { groupId: anchor.current!, anchor: "build", direction: "vertical" }
        : undefined,
    });
    expect(result.current).toBeUndefined();
    expect(groupFor(result, "created")).toBeDefined();
    expect(groupFor(result, "build")?.active).toBe("build");
  },
);

test.each(["moved", "closed"] as const)(
  "an ungrouped create gets its own group if the original anchor was %s",
  (change) => {
    let layout = selectSession(emptyLayout(), "anchor");
    const target = layout.current!;
    layout = splitSession(layout, "companion", target, "anchor", "horizontal");
    layout =
      change === "moved"
        ? moveSession(layout, "anchor")
        : closeSession(closeSession(layout, "anchor"), "companion");
    const result = placeCreatedSession(layout, "created", {
      activate: true,
      split: { groupId: target, anchor: "anchor", direction: "vertical" },
    });
    expect(members(currentGroup(result)!)).toEqual(["created"]);
    expect(result.groups.find((group) => group.id === target)?.root).toEqual(
      layout.groups.find((group) => group.id === target)?.root,
    );
  },
);

test("an inactive create keeps an existing group when its original split anchor is gone", () => {
  let layout = selectSession(emptyLayout(), "anchor");
  const target = layout.current!;
  layout = selectSession(closeSession(layout, "anchor"), "published");
  const publishedGroup = layout.current!;
  layout = selectSession(layout, "shell");
  const result = placeCreatedSession(layout, "published", {
    activate: false,
    split: { groupId: target, anchor: "anchor", direction: "vertical" },
  });
  expect(groupFor(result, "published")?.id).toBe(publishedGroup);
  expect(members(groupFor(result, "published")!)).toEqual(["published"]);
  expect(currentGroup(result)?.active).toBe("shell");
  expect(result.groups.flatMap(members)).toEqual(["published", "shell"]);
});

test("a published and selected session stays selected when the create result moves it", () => {
  const original = selectSession(emptyLayout(), "anchor");
  const selected = selectSession(original, "published");
  const before = structuredClone(selected);
  const result = placeCreatedSession(selected, "published", {
    activate: false,
    split: { groupId: original.current!, anchor: "anchor", direction: "vertical" },
  });
  expect(result.groups).toHaveLength(1);
  expect(result.current).toBe(original.current);
  expect(currentGroup(result)?.active).toBe("published");
  expect(members(currentGroup(result)!)).toEqual(["anchor", "published"]);
  expect(selected).toEqual(before);
});

test("retains an opened end screen until its display is closed", () => {
  const layout = selectSession(emptyLayout(), "ended");
  const kept = retainSessions(layout, new Set(["ended"]));
  expect(members(currentGroup(kept)!)).toEqual(["ended"]);
  expect(retainSessions(kept, new Set()).groups).toEqual([]);
});

test("hiding groups preserves their tree and selection, including an empty visible area", () => {
  let layout = selectSession(emptyLayout(), "build");
  const first = layout.current!;
  layout = splitSession(layout, "tests", first, "build", "horizontal");
  layout = selectSession(layout, "shell");
  const second = layout.current!;
  const groups = layout.groups;

  layout = showGroup(layout, first, false);
  expect(layout.current).toBe(second);
  expect(layout.groups[0]).toEqual({ ...groups[0], hidden: true });
  layout = showGroup(layout, second, false);
  expect(layout.current).toBeUndefined();
  expect(layout.groups.every((group) => group.hidden)).toBe(true);
  layout = showGroup(layout, first, true);
  expect(layout.current).toBe(first);
  expect(layout.groups[0]).toEqual(groups[0]);
  layout = selectSession(layout, "shell");
  expect(layout.current).toBe(second);
  expect(layout.groups).toEqual(groups);

  layout = showGroup(layout, second, false);
  expect(layout.current).toBe(first);
  expect(currentGroup(layout)?.active).toBe("tests");
});

test("explicit moves and splits reveal their hidden destination group", () => {
  const initial = selectSession(emptyLayout(), "build");
  const target = initial.current!;
  const hidden = showGroup(selectSession(initial, "shell"), target, false);
  for (const result of [
    moveSession(hidden, "shell", target),
    splitSession(hidden, "new", target, "build", "vertical"),
  ]) {
    expect(result.current).toBe(target);
    expect(currentGroup(result)?.hidden).toBeUndefined();
    expect(members(currentGroup(result)!)[0]).toBe("build");
  }
  expect(hidden.groups[0]?.hidden).toBe(true);
});
