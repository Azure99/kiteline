import { afterEach, describe, expect, test, vi } from "vitest";
import { emptyLayout, showGroup, type TerminalLayout } from "../src/terminal/groups";
import {
  readTerminalLayouts,
  terminalLayoutsKey,
  writeTerminalLayouts,
} from "../src/terminal/layout-storage";
import { WorkspaceMemories, workspaceKey } from "../src/workspace/memory";

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

test("writes and restores workspace layouts", () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => (stored = value),
  };
  expect(readTerminalLayouts(storage).size).toBe(0);
  const layouts = new Map([["device:workspace", layout]]);
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

describe("workspace memory", () => {
  const target = { deviceId: "device", workspaceId: "workspace" };
  const other = { deviceId: "device", workspaceId: "other" };

  function installStorage(initial: string | null = null) {
    const values = new Map<string, string>();
    if (initial !== null) values.set(terminalLayoutsKey, initial);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    vi.stubGlobal("sessionStorage", storage);
    return storage;
  }

  afterEach(() => vi.unstubAllGlobals());

  test("retains each target's presentation, pages and repo browsing and clears them together", () => {
    const storage = installStorage();
    const memories = new WorkspaceMemories();
    expect(memories.get(target)).toBeUndefined();
    const record = memories.forTarget(target);
    record.presentation = {
      state: {
        mode: "both",
        mobileMode: "work",
        rightTool: "git",
        position: "left",
        ratio: 43,
        rightToolsOpen: true,
        rightToolsWidth: 320,
      },
      path: "/devices/device/workspaces/workspace/git?repo=root",
    };
    record.pages = {
      items: [{ kind: "file", id: "file:one", path: "one.txt" }],
      active: "file:one",
    };
    record.browsing.set("root", {
      layout: {
        view: "history",
        changesOpen: false,
        readingView: "history",
        readingOpen: true,
        ratio: 35,
      },
      history: { parent: "root-parent" },
    });
    record.browsing.set("nested", {
      layout: {
        view: "branches",
        changesOpen: true,
        readingView: "branches",
        readingOpen: true,
      },
      history: { parent: "nested-parent" },
    });
    memories.saveTerminalLayout(record, layout);

    const returned = memories.forTarget(target);
    expect(returned.presentation?.path).toBe("/devices/device/workspaces/workspace/git?repo=root");
    expect(returned.pages?.active).toBe("file:one");
    expect(returned.browsing.get("root")?.history.parent).toBe("root-parent");
    expect(returned.browsing.get("nested")?.history.parent).toBe("nested-parent");
    expect(returned.terminalLayout).toBe(layout);
    expect(memories.get(other)).toBeUndefined();
    const otherRecord = memories.forTarget(other);
    expect(otherRecord.presentation).toBeUndefined();
    expect(otherRecord.pages).toBeUndefined();
    expect(otherRecord.browsing.get("root")).toBeUndefined();

    memories.clear();
    expect(storage.getItem(terminalLayoutsKey)).toBeNull();
    expect(memories.get(target)).toBeUndefined();
    expect(memories.get(other)).toBeUndefined();
    const fresh = memories.forTarget(target);
    memories.saveTerminalLayout(record, emptyLayout());
    expect(fresh.presentation).toBeUndefined();
    expect(fresh.pages).toBeUndefined();
    expect(fresh.terminalLayout).toBeUndefined();
    expect(fresh.browsing.get("root")).toBeUndefined();
    expect(readTerminalLayouts(storage).get(workspaceKey(target))).toBeUndefined();
  });

  test("restores original entries and persists only recorded terminal layouts, including empty selections", () => {
    const storage = installStorage(JSON.stringify([[workspaceKey(target), layout]]));
    const memories = new WorkspaceMemories();
    const restored = memories.get(target);
    expect(restored?.terminalLayout).toEqual(layout);
    expect(restored?.presentation).toBeUndefined();
    expect(restored?.pages).toBeUndefined();
    memories.forTarget(other).pages = { items: [] };
    const closed = { deviceId: "device", workspaceId: "closed" };
    memories.saveTerminalLayout(memories.forTarget(closed), emptyLayout());
    const unselected = { deviceId: "device", workspaceId: "unselected" };
    memories.saveTerminalLayout(memories.forTarget(unselected), { ...layout, current: undefined });

    expect(JSON.parse(storage.getItem(terminalLayoutsKey)!)).toEqual([
      [workspaceKey(target), layout],
      [workspaceKey(closed), emptyLayout()],
      [workspaceKey(unselected), { groups: layout.groups }],
    ]);
  });

  test("uses defaults when reading storage fails or the saved entries are unreadable", () => {
    const failure = new Error("Storage unavailable");
    for (const getItem of [
      () => {
        throw failure;
      },
      () =>
        JSON.stringify([
          [workspaceKey(target), layout],
          [workspaceKey(other), {}],
        ]),
    ]) {
      vi.stubGlobal("sessionStorage", { getItem });
      const memories = new WorkspaceMemories();
      expect(memories.get(target)).toBeUndefined();
      expect(memories.forTarget(target).terminalLayout).toBeUndefined();
    }
  });

  test("retains memory after a failed write and clears memory even when storage removal fails", () => {
    const storage = installStorage();
    const memories = new WorkspaceMemories();
    const record = memories.forTarget(target);
    storage.setItem = () => {
      throw new Error("Storage full");
    };
    expect(() => memories.saveTerminalLayout(record, layout)).not.toThrow();
    expect(memories.get(target)?.terminalLayout).toBe(layout);
    storage.removeItem = () => {
      throw new Error("Storage unavailable");
    };
    expect(() => memories.clear()).not.toThrow();
    expect(memories.get(target)).toBeUndefined();
  });

  test("keeps the same memory policy when accessing sessionStorage itself throws", () => {
    installStorage();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("Storage unavailable");
      },
    });
    const memories = new WorkspaceMemories();
    const record = memories.forTarget(target);
    expect(record.terminalLayout).toBeUndefined();
    expect(() => memories.saveTerminalLayout(record, layout)).not.toThrow();
    expect(memories.get(target)?.terminalLayout).toBe(layout);
    expect(() => memories.clear()).not.toThrow();
    expect(memories.get(target)).toBeUndefined();
  });
});
