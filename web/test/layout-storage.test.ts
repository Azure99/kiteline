import { expect, test } from "vitest";
import { emptyLayout, members, showGroup, type TerminalLayout } from "../src/terminal/groups";
import { readTerminalLayouts, writeTerminalLayouts } from "../src/terminal/layout-storage";

const layout: TerminalLayout = {
  groups: [
    {
      id: "one",
      active: "b",
      maximized: true,
      root: {
        id: "horizontal",
        direction: "horizontal",
        sizes: { a: 30, vertical: 70 },
        children: [
          { id: "a", sessionId: "a" },
          {
            id: "vertical",
            direction: "vertical",
            sizes: { b: 65, c: 35 },
            children: [
              { id: "b", sessionId: "b" },
              { id: "c", sessionId: "c" },
            ],
          },
        ],
      },
    },
    { id: "two", active: "d", maximized: false, root: { id: "d", sessionId: "d" } },
  ],
  current: "one",
};

test("restores recursive proportions, groups, active panes, maximization", () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => (stored = value),
  };
  expect(readTerminalLayouts(storage).size).toBe(0);
  const layouts = new Map([
    ["device:workspace", layout],
    ["device:closed", emptyLayout()],
  ]);
  writeTerminalLayouts(storage, layouts);
  expect(readTerminalLayouts(storage)).toEqual(layouts);
});

test("preserves layouts without a current group", () => {
  for (const item of [{ ...layout, current: undefined }, emptyLayout()]) {
    const saved = JSON.stringify([["workspace", item]]);
    expect(readTerminalLayouts({ getItem: () => saved }).get("workspace")).toEqual(item);
  }
});

test("restores hidden groups with their proportions and an empty visible area", () => {
  const oneHidden = showGroup(layout, "one", false);
  const allHidden = showGroup(oneHidden, "two", false);
  for (const item of [oneHidden, allHidden]) {
    let stored = "";
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => (stored = value),
    };
    writeTerminalLayouts(storage, new Map([["workspace", item]]));
    const restored = readTerminalLayouts(storage).get("workspace")!;
    expect(restored).toEqual(item);
    expect(showGroup(restored, "one", true).groups[0]).toEqual(layout.groups[0]);
  }
});

test("restores a former companion as a group without replacing the current selection", () => {
  for (const dock of ["b", "independent"]) {
    const saved = JSON.stringify([
      ["workspace", { ...layout, dock, dockOpen: true, dockSize: 40 }],
    ]);
    const restored = readTerminalLayouts({ getItem: () => saved }).get("workspace")!;
    expect(restored.current).toBe(layout.current);
    expect(restored.groups.slice(0, 2)).toEqual(layout.groups);
    expect(
      restored.groups.flatMap((group) => members(group)).filter((id) => id === dock),
    ).toHaveLength(1);
    expect(restored).not.toHaveProperty("dock");
  }
});

test("rejects unreadable layouts rather than restoring broken trees or selections", () => {
  const missingSizes = structuredClone(layout);
  if ("sizes" in missingSizes.groups[0]!.root) missingSizes.groups[0]!.root.sizes = {};
  const missingActive = structuredClone(layout);
  missingActive.groups[0]!.active = "absent";
  const duplicateSession = structuredClone(layout);
  duplicateSession.groups[1]!.root = { id: "another", sessionId: "a" };
  for (const saved of [
    "invalid json",
    JSON.stringify([["workspace", missingSizes]]),
    JSON.stringify([["workspace", missingActive]]),
    JSON.stringify([["workspace", duplicateSession]]),
  ])
    expect(() => readTerminalLayouts({ getItem: () => saved })).toThrow();
});

test("exposes storage failures and leaves the in-memory layout available", () => {
  const failure = new Error("Storage unavailable");
  expect(() =>
    readTerminalLayouts({
      getItem() {
        throw failure;
      },
    }),
  ).toThrow(failure);
  const layouts = new Map([["workspace", layout]]);
  expect(() =>
    writeTerminalLayouts(
      {
        setItem() {
          throw failure;
        },
      },
      layouts,
    ),
  ).toThrow(failure);
  expect(layouts.get("workspace")).toBe(layout);
});
