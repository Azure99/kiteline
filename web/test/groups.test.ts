import { expect, test } from "vitest";
import {
  closeSession,
  currentGroup,
  emptyLayout,
  moveSession,
  retainSessions,
  selectSession,
} from "../src/terminal/groups";

test("moving existing sessions preserves identity and removes empty groups", () => {
  let layout = selectSession(emptyLayout(), "build");
  const target = layout.current;
  layout = moveSession(layout, "tests", target);
  layout = moveSession(layout, "shell", target);
  const original = layout;
  layout = moveSession(layout, "shell", target, "build");
  expect(currentGroup(layout)?.members).toEqual(["shell", "build", "tests"]);
  expect(currentGroup(original)?.members).toEqual(["build", "tests", "shell"]);
  layout = moveSession(layout, "shell");
  expect(layout.groups).toHaveLength(2);
  expect(currentGroup(layout)?.members).toEqual(["shell"]);
  layout = moveSession(layout, "shell", target);
  expect(layout.groups).toHaveLength(1);
  expect(new Set(currentGroup(layout)?.members)).toEqual(new Set(["shell", "build", "tests"]));
});

test("closing the last display keeps the closed state instead of opening another group", () => {
  const first = selectSession(emptyLayout(), "build");
  const layout = closeSession(selectSession(first, "tests"), "tests");
  expect(layout.current).toBeUndefined();
  expect(layout.groups[0]?.members).toEqual(["build"]);
  expect(currentGroup(selectSession(layout, "tests"))?.members).toEqual(["tests"]);
});

test("a retained companion end screen does not keep a released main group", () => {
  const layout = { ...selectSession(emptyLayout(), "ended"), dock: "ended", dockOpen: true };
  const kept = retainSessions(layout, new Set(), new Set(["ended"]));
  expect(kept.groups).toEqual([]);
  expect(kept.dock).toBe("ended");
  expect(retainSessions(kept, new Set()).dock).toBeUndefined();
});
