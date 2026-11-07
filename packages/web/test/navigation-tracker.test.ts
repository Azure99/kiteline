import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { diff } from "@codemirror/merge";
import type { Transaction, TransactionSpec } from "@codemirror/state";
import type { Device, SearchMatch } from "@kiteline/shared/protocol";
import { DraftStore, type Draft } from "../src/files/drafts";
import { inspectNavigation } from "../src/files/navigation-candidates";
import { NavigationTracker } from "../src/files/navigation-tracker";
import { syncTextTransactions } from "../src/files/editor-state";
import { diskText } from "./disk-text";
import { diffText } from "../src/files/text-diff";

vi.mock("../src/files/text-diff", () => ({ diffText: vi.fn() }));
beforeEach(() => {
  vi.mocked(diffText).mockReset();
  vi.mocked(diffText).mockImplementation(async (before, after, signal) => {
    if (signal.aborted) throw new DOMException("Text comparison cancelled", "AbortError");
    return diff(before, after);
  });
});

const target = { deviceId: "device", workspaceId: "workspace" };

function fixture(text: string, caret = text.indexOf("name"), dirtyPrefix = "") {
  vi.stubGlobal("window", new EventTarget());
  const store = new DraftStore();
  store.observeDevices([{ id: target.deviceId, editorBytes: 1024 * 1024 } as Device]);
  const draft = open(store, "main.ts", text);
  if (dirtyPrefix) apply(store, draft, { changes: { from: 0, insert: dirtyPrefix } });
  apply(store, draft, { selection: { anchor: caret + dirtyPrefix.length } });
  const state = draft.state!;
  const line = state.doc.lineAt(state.selection.main.head);
  const request = {
    initialGroup: "definitions" as const,
    context: inspectNavigation(state, "name"),
    origin: {
      path: draft.path,
      draftId: draft.id,
      line: line.number,
      column: state.selection.main.head - line.from,
      scrollSnapshot: { line: 1, column: 0, offsetX: -80, offsetY: -7 },
    },
  };
  return { store, draft, request, tracker: new NavigationTracker(store, target, request) };
}

function open(store: DraftStore, path: string, text: string) {
  return store.open(
    { ...target, path, deviceName: "Device", workspaceName: "Workspace" },
    diskText({ path, text, revision: "initial" }),
  );
}

function apply(store: DraftStore, draft: Draft, spec: TransactionSpec | Transaction) {
  const transaction = "startState" in spec ? spec : draft.state!.update(spec);
  store.update(draft, transaction.state, undefined, [transaction]);
}

function matches(text: string, path = "main.ts"): SearchMatch[] {
  return text.split("\n").flatMap((text, index) => {
    const ranges: [number, number][] = [...text.matchAll(/name/g)].map((match) => [
      match.index,
      match.index + 4,
    ]);
    return ranges.length ? [{ path, text, line: index + 1, ranges }] : [];
  });
}

const repeated = "const name = 1;\nname(a);\nname(a);\nname(b);";
afterEach(() => vi.unstubAllGlobals());

test("deletion before rg completes never gives a duplicate the origin identity, including after Undo", async () => {
  const offset = repeated.indexOf("name(a)");
  const { store, draft, tracker } = fixture(repeated, offset);
  apply(store, draft, { changes: { from: offset, to: offset + 9 } });
  await tracker.setResult(
    { matches: matches(repeated), truncated: false },
    new AbortController().signal,
  );
  expect(tracker.snapshot()).toHaveLength(3);
  expect(tracker.snapshot().some((entry) => entry.isOrigin)).toBe(false);
  const survivor = tracker.snapshot().find((entry) => entry.match.line === 2)!;
  expect(survivor.match.text).toBe("name(a);");
  expect(tracker.originLocation().unmapped).toBe(true);
  expect(
    undo({ state: draft.state!, dispatch: (transaction) => apply(store, draft, transaction) }),
  ).toBe(true);
  expect(draft.state!.doc.toString()).toBe(repeated);
  expect(tracker.snapshot()).toHaveLength(3);
  expect(tracker.snapshot().some((entry) => entry.isOrigin)).toBe(false);
  expect(tracker.snapshot().find((entry) => entry.key === survivor.key)?.match.line).toBe(3);
});

test("dirty initialization is mapped once, then edits preserve exact candidate identities", async () => {
  const { store, draft, tracker } = fixture(repeated, repeated.lastIndexOf("name"), "// dirty\n");
  await tracker.setResult(
    { matches: matches(repeated), truncated: false },
    new AbortController().signal,
  );
  const selected = tracker.snapshot().find((entry) => entry.match.line === 4)!;
  const first = draft.state!.doc.line(3);
  apply(store, draft, { changes: { from: first.from, to: first.to + 1 } });
  expect(tracker.entryLocation(selected.key)).toMatchObject({ line: 3, column: 0, endColumn: 4 });
  expect(tracker.snapshot().filter((entry) => entry.isOrigin)).toHaveLength(1);
  expect(tracker.originLocation()).toMatchObject({ line: 4, column: 0 });
});

test("a fresh lookup after deletion and Undo uses the current dirty selection as its origin", async () => {
  const { store, draft, request, tracker } = fixture(repeated, repeated.indexOf("name(a)"));
  const removed = draft.state!.doc.line(2);
  apply(store, draft, { changes: { from: removed.from, to: removed.to + 1 } });
  expect(
    undo({ state: draft.state!, dispatch: (transaction) => apply(store, draft, transaction) }),
  ).toBe(true);
  expect(tracker.originLocation().unmapped).toBe(true);
  apply(store, draft, { changes: { from: 0, insert: "// dirty\n" } });
  const current = draft.state!.doc.line(5);
  apply(store, draft, { selection: { anchor: current.from + 2 } });
  tracker.dispose();
  const next = new NavigationTracker(store, target, {
    ...request,
    context: inspectNavigation(draft.state!, "name"),
    origin: { ...request.origin, line: 5, column: 2 },
  });
  await next.setResult(
    { matches: matches(repeated), truncated: false },
    new AbortController().signal,
  );
  expect(next.snapshot()).toHaveLength(4);
  expect(next.snapshot().filter((entry) => entry.isOrigin)).toMatchObject([
    { match: { line: 5, text: "name(b);" } },
  ]);
  expect(next.originLocation()).toMatchObject({ line: 5, column: 2 });
  next.dispose();
});

test("boundary insertions preserve the hit and an interior edit makes it unavailable", async () => {
  const { store, draft, tracker } = fixture("name();");
  apply(store, draft, {
    changes: [
      { from: 0, insert: "  " },
      { from: 4, insert: " " },
    ],
  });
  expect(tracker.originLocation()).toMatchObject({ line: 1, column: 2 });
  apply(store, draft, { changes: { from: 4, insert: "X" } });
  expect(tracker.originLocation().unmapped).toBe(true);
});

test("a removed viewport anchor maps independently of the surviving origin", async () => {
  const { store, draft, tracker } = fixture("// first\nname();", 9);
  apply(store, draft, { changes: { from: 0, to: 9 } });
  expect(tracker.originLocation()).toMatchObject({
    line: 1,
    column: 0,
    scrollSnapshot: { line: 1, column: 0, offsetX: -80, offsetY: -7 },
  });
});

test("an existing background draft is tracked while rg is pending, including partial deletion and Undo", async () => {
  const { store, request, tracker: initial } = fixture("name();");
  initial.dispose();
  const other = open(store, "other.ts", "name();\nname();");
  const tracker = new NavigationTracker(store, target, request);
  apply(store, other, { changes: { from: 1, to: 2 } });
  await tracker.setResult(
    { matches: matches("name();\nname();", "other.ts"), truncated: false },
    new AbortController().signal,
  );
  expect(tracker.snapshot().filter((entry) => entry.match.path === "other.ts")).toHaveLength(1);
  expect(
    undo({ state: other.state!, dispatch: (transaction) => apply(store, other, transaction) }),
  ).toBe(true);
  const otherEntries = tracker.snapshot().filter((entry) => entry.match.path === "other.ts");
  expect(otherEntries).toHaveLength(1);
  expect(otherEntries[0]?.match.line).toBe(2);
});

test("a cold candidate binds on first draft load and retains its key through subsequent edits", async () => {
  const { store, tracker } = fixture("name();");
  await tracker.setResult(
    { matches: matches("name();", "other.ts"), truncated: false },
    new AbortController().signal,
  );
  const key = tracker.snapshot().find((entry) => entry.match.path === "other.ts")!.key;
  expect(tracker.entryLocation(key).source).toBe("disk");
  const other = open(store, "other.ts", "name();");
  expect(tracker.entryLocation(key)).toMatchObject({ source: "draft", line: 1, column: 0 });
  apply(store, other, { changes: { from: 0, insert: "// inserted\n" } });
  expect(tracker.entryLocation(key)).toMatchObject({ source: "draft", line: 2, column: 0 });
});

test("candidate reading selection and both scroll offsets map without replacing its hit position", async () => {
  const { store, draft, tracker } = fixture("name();\n// context\n// reading");
  await tracker.setResult(
    { matches: matches("name();\n// context\n// reading"), truncated: false },
    new AbortController().signal,
  );
  const key = tracker.snapshot()[0]!.key;
  tracker.captureReading(key, {
    line: 3,
    column: 3,
    endColumn: 10,
    scrollSnapshot: { line: 2, column: 2, offsetX: -120, offsetY: -4 },
  });
  apply(store, draft, { changes: { from: 0, insert: "// new\n" } });
  expect(tracker.entryLocation(key)).toMatchObject({ line: 2, column: 0, endColumn: 4 });
  expect(tracker.entryLocation(key, true)).toMatchObject({
    line: 4,
    column: 3,
    endColumn: 10,
    scrollSnapshot: { line: 3, column: 2, offsetX: -120, offsetY: -4 },
  });
  const hit = draft.state!.doc.line(2);
  apply(store, draft, { changes: { from: hit.from, to: hit.from + 4 } });
  expect(tracker.entryLocation(key, true).unmapped).toBe(true);
});

test("unmappable preexisting disk hits remain visible while a known deleted hit is removed", async () => {
  const { store, draft, request, tracker: initial } = fixture("name();\nname();");
  initial.dispose();
  apply(store, draft, { changes: { from: 0, to: 4, insert: "other" } });
  apply(store, draft, { selection: { anchor: draft.state!.doc.line(2).from } });
  const tracker = new NavigationTracker(store, target, {
    ...request,
    context: inspectNavigation(draft.state!, "name"),
    origin: { ...request.origin, line: 2, column: 0 },
  });
  await tracker.setResult(
    { matches: matches("name();\nname();"), truncated: false },
    new AbortController().signal,
  );
  expect(tracker.snapshot()).toHaveLength(2);
  const unknown = tracker.snapshot().find((entry) => entry.source === "disk")!;
  expect(unknown.match.line).toBe(1);
  expect(tracker.entryLocation(unknown.key).unmapped).toBe(true);
  const second = draft.state!.doc.line(2);
  apply(store, draft, { changes: { from: second.from, to: second.from + 4 } });
  expect(tracker.snapshot()).toHaveLength(1);
  expect(tracker.snapshot()[0]!.key).toBe(unknown.key);
  apply(store, draft, { changes: { from: 0, to: 5, insert: "name" } });
  expect(tracker.entryLocation(unknown.key).unmapped).toBe(true);
  apply(store, draft, { selection: { anchor: 1 } });
  const fresh = new NavigationTracker(store, target, {
    ...request,
    context: inspectNavigation(draft.state!, "name"),
    origin: { ...request.origin, line: 1, column: 1 },
  });
  await fresh.setResult(
    { matches: matches("name();\nname();"), truncated: false },
    new AbortController().signal,
  );
  const restored = fresh.snapshot().find((entry) => entry.match.line === 1)!;
  expect(restored.source).toBe("draft");
  expect(fresh.entryLocation(restored.key)).toMatchObject({ line: 1, column: 0 });
  expect(fresh.entryLocation(restored.key).unmapped).not.toBe(true);
  fresh.dispose();
});

test("only matched dirty initial documents prepare once in sequence while real edits keep their identity", async () => {
  const { store, request, tracker: initial } = fixture("name();", 0, "// origin\n");
  initial.dispose();
  const first = open(store, "first.ts", "name();\nname();");
  const second = open(store, "second.ts", "name();");
  const unrelated = open(store, "unrelated.ts", "name();");
  for (const draft of [first, second, unrelated])
    apply(store, draft, { changes: { from: 0, insert: `// ${draft.path}\n` } });
  const firstInitial = first.state!.doc.toString();
  const secondInitial = second.state!.doc.toString();
  const tracker = new NavigationTracker(store, target, request);
  expect(diffText).not.toHaveBeenCalled();
  let finish!: () => void;
  vi.mocked(diffText).mockImplementationOnce(
    (before, after) =>
      new Promise((resolve) => {
        finish = () => resolve(diff(before, after));
      }),
  );
  const result = {
    matches: [...matches("name();\nname();", first.path), ...matches("name();", second.path)],
    truncated: false,
  };
  const pending = tracker.setResult(result, new AbortController().signal);
  expect(vi.mocked(diffText).mock.calls.map(([before, after]) => [before, after])).toEqual([
    [first.baseText, firstInitial],
  ]);
  expect(tracker.snapshot().map((entry) => entry.match.path)).toEqual(["main.ts"]);
  const deleted = first.state!.doc.line(2).from;
  apply(store, first, { changes: { from: deleted + 1, to: deleted + 2 } });
  expect(
    undo({ state: first.state!, dispatch: (transaction) => apply(store, first, transaction) }),
  ).toBe(true);
  expect(first.state!.doc.toString()).toBe(firstInitial);
  finish();
  await pending;
  expect(vi.mocked(diffText).mock.calls.map(([before, after]) => [before, after])).toEqual([
    [first.baseText, firstInitial],
    [second.baseText, secondInitial],
  ]);
  expect(tracker.snapshot().filter((entry) => entry.match.path === first.path)).toMatchObject([
    { match: { line: 3 } },
  ]);
  await tracker.setResult(result, new AbortController().signal);
  expect(diffText).toHaveBeenCalledTimes(2);
  tracker.dispose();
});

test("retry aborts the previous request before clearing and publishing its replacement", async () => {
  const { tracker } = fixture("name();", 0, "// dirty\n");
  const previous = new AbortController();
  let finish!: () => void;
  vi.mocked(diffText).mockImplementationOnce(
    (before, after) =>
      new Promise((resolve) => {
        finish = () => resolve(diff(before, after));
      }),
  );
  const pending = tracker.setResult(
    { matches: [...matches("name();"), ...matches("name();", "late.ts")], truncated: false },
    previous.signal,
  );
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  previous.abort();
  const next = new AbortController();
  await tracker.setResult(undefined, next.signal);
  await tracker.setResult(
    { matches: matches("name();", "next.ts"), truncated: false },
    next.signal,
  );
  finish();
  await cancelled;
  expect(tracker.snapshot().some((entry) => entry.match.path === "late.ts")).toBe(false);
  expect(tracker.snapshot().some((entry) => entry.match.path === "next.ts")).toBe(true);
  tracker.dispose();
});

test("Workspace disposal rejects late publication independently of the hook's request signal", async () => {
  const { tracker } = fixture("name();", 0, "// dirty\n");
  let finish!: () => void;
  vi.mocked(diffText).mockImplementationOnce(
    (before, after) =>
      new Promise((resolve) => {
        finish = () => resolve(diff(before, after));
      }),
  );
  const pending = tracker.setResult(
    { matches: matches("name();"), truncated: false },
    new AbortController().signal,
  );
  tracker.dispose();
  finish();
  await pending;
  expect(tracker.snapshot()).toEqual([]);
});

test("a failed comparison rejects without publishing disk results", async () => {
  const { tracker } = fixture("name();", 0, "// dirty\n");
  const failure = new Error("Comparison failed");
  vi.mocked(diffText).mockRejectedValueOnce(failure);
  await expect(
    tracker.setResult(
      { matches: [...matches("name();"), ...matches("name();", "other.ts")], truncated: false },
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(tracker.snapshot().map((entry) => entry.match.path)).toEqual(["main.ts"]);
  tracker.dispose();
});

test.each(["replaceSource", "full replacement", "syncTextTransactions", "close and reopen"])(
  "%s cannot recover an existing identity from equal final text",
  async (mode) => {
    const { store, draft, tracker } = fixture("name();");
    if (mode === "replaceSource")
      store.replaceSource(draft, diskText({ path: draft.path, text: "name();", revision: "next" }));
    else if (mode === "full replacement")
      apply(store, draft, { changes: { from: 0, to: 7, insert: "name();" } });
    else if (mode === "syncTextTransactions") {
      const transactions = syncTextTransactions(draft.state!, "name();");
      store.update(draft, transactions[1].state);
    } else {
      store.close(draft);
      open(store, draft.path, "name();");
    }
    expect(tracker.originLocation().unmapped).toBe(true);
  },
);

test("only related edits change results and disposal stops further updates", async () => {
  const { store, draft, tracker } = fixture("name();");
  const listener = vi.fn();
  tracker.subscribe(listener);
  const initial = tracker.snapshot();
  apply(store, draft, { selection: { anchor: 2 } });
  const other = store.open({
    ...target,
    workspaceId: "other",
    path: "",
    deviceName: "Device",
    workspaceName: "Other",
  });
  apply(store, other, { changes: { from: 0, insert: "name" } });
  expect(tracker.snapshot()).toEqual(initial);
  apply(store, draft, { changes: { from: 0, insert: " " } });
  expect(tracker.snapshot()).toMatchObject([{ match: { line: 1, ranges: [[1, 5]] } }]);
  listener.mockClear();
  tracker.dispose();
  apply(store, draft, { changes: { from: 0, insert: " " } });
  expect(listener).not.toHaveBeenCalled();
  expect(tracker.snapshot()).toEqual([]);
});
