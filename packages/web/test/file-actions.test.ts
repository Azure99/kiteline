import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isolateHistory, undo } from "@codemirror/commands";
import type { CopyItem, Device, FileItemResult } from "@kiteline/shared/protocol";
import { operateFiles } from "../src/files/actions";
import type { DiskText } from "../src/files/content";
import { DraftStore, isDirty } from "../src/files/drafts";
import { ApiError } from "../src/lib/api";
import { diskText } from "./disk-text";

const transport = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../src/files/content", () => ({
  readText: transport.read,
  writeText: transport.write,
}));
const target = { deviceId: "device", workspaceId: "workspace" };
let store: DraftStore;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function open(store: DraftStore, path: string) {
  return store.open(
    { ...target, path, deviceName: "Device", workspaceName: "Workspace" },
    diskText({ path, text: "base", revision: "base" }),
  );
}
function item(path: string, targetPath = `moved/${path}`): CopyItem {
  return { path, targetPath, collision: "error" };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", new EventTarget());
  store = new DraftStore();
  store.observeDevices([{ id: target.deviceId, editorBytes: 1024 } as Device]);
});
afterEach(() => vi.unstubAllGlobals());

test.each(["move", "delete"] as const)(
  "%s rejects the whole batch for a saving source, prepared target or their ancestors without RPC",
  async (kind) => {
    const draft = open(store, "source/a.txt");
    const saved = deferred<{ path: string; size: number; revision: string }>();
    transport.write.mockImplementationOnce((_target, _bytes, _revision, _signal, prepared) => {
      prepared("canonical/copy.txt");
      return saved.promise;
    });
    const saving = store.save(draft, { kind: "create", path: "requested/copy.txt" });
    const operation = draft.operation;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const path of ["source/a.txt", "source", "canonical/copy.txt", "canonical"]) {
      const result = await operateFiles(store, target, kind, [item("unrelated.txt"), item(path)], {
        id: `${kind}-${path}`,
        signal: new AbortController().signal,
      });
      expect(result.items).toEqual(
        ["unrelated.txt", path].map((path) => ({
          path,
          targetPath: `moved/${path}`,
          outcome: "failed",
        })),
      );
      expect(result.error).toMatchObject({ code: "busy", outcome: "failed" });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    expect(draft.path).toBe("source/a.txt");
    expect(draft.operation).toBe(operation);
    saved.resolve({ path: "canonical/copy.txt", size: 4, revision: "saved" });
    expect(await saving).toEqual({ kind: "saved" });
  },
);

test("move checks replacement targets but leaves other destinations and workspaces to the RPC", async () => {
  const draft = open(store, "source/a.txt");
  const saved = deferred<{ path: string; size: number; revision: string }>();
  transport.write.mockReturnValueOnce(saved.promise);
  const saving = store.save(draft, { kind: "create", path: "destination/copy.txt" });
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    return Response.json({
      id: request.id,
      outcome: "succeeded",
      result: {
        items: request.params.items.map((item: CopyItem) => ({
          path: item.path,
          targetPath: item.targetPath,
          outcome: "succeeded",
        })),
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const request = { id: "move", signal: new AbortController().signal };
  for (const path of ["source/a.txt", "source", "destination/copy.txt", "destination"]) {
    const replacement: CopyItem = {
      path: "unrelated.txt",
      targetPath: path,
      collision: "replace",
      expectedTargetVersion: "confirmed",
    };
    const result = await operateFiles(store, target, "move", [replacement], request);
    expect(result.error).toMatchObject({ code: "busy", outcome: "failed" });
    expect(result.items).toEqual([{ path: "unrelated.txt", targetPath: path, outcome: "failed" }]);
  }
  expect(fetch).not.toHaveBeenCalled();
  const source = item("source/a.txt");
  const allowed = [
    { scope: target, items: [item("unrelated.txt", "destination/copy.txt")] },
    { scope: target, items: [item("source/a.txt.bak")] },
    { scope: { ...target, deviceId: "another-device" }, items: [source] },
    { scope: { ...target, workspaceId: "another-workspace" }, items: [source] },
  ];
  for (const { scope, items } of allowed) {
    expect(await operateFiles(store, scope, "move", items, request)).toEqual({
      items: items.map((item) => ({
        path: item.path,
        targetPath: item.targetPath,
        outcome: "succeeded",
      })),
      error: undefined,
    });
  }
  expect(fetch).toHaveBeenCalledTimes(allowed.length);
  saved.resolve({ path: "destination/copy.txt", size: 4, revision: "saved" });
  expect(await saving).toEqual({ kind: "saved" });
});

test("move fixes the submitted batch and drafts, preserving the editor before disk recheck finishes", async () => {
  const draft = open(store, "dir/a.txt");
  store.update(
    draft,
    draft.state!.update({
      changes: { from: 4, insert: " edited" },
      annotations: isolateHistory.of("full"),
    }).state,
  );
  const state = draft.state;
  const reply = deferred<Response>();
  const recheck = deferred<DiskText>();
  transport.read.mockReturnValueOnce(recheck.promise);
  const fetch = vi.fn((_url: string, _options: RequestInit) => reply.promise);
  vi.stubGlobal("fetch", fetch);
  const abort = new AbortController();
  const items = [item("dir", "moved")];
  const running = operateFiles(store, target, "move", items, { id: "move", signal: abort.signal });
  items[0]!.path = "different";
  items[0]!.targetPath = "elsewhere";
  items.push(item("extra"));
  const later = open(store, "dir/later.txt");
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
    id: "move",
    method: "files.move",
    params: { workspaceId: target.workspaceId, items: [item("dir", "moved")] },
  });
  expect(fetch.mock.calls[0]![1]!.signal).toBe(abort.signal);
  reply.resolve(
    Response.json({
      id: "move",
      outcome: "succeeded",
      result: { items: [{ path: "dir", targetPath: "moved", outcome: "succeeded" }] },
    }),
  );
  const result = await running;
  expect(result).toEqual({
    items: [{ path: "dir", targetPath: "moved", outcome: "succeeded" }],
    error: undefined,
  });
  expect(draft.path).toBe("moved/a.txt");
  expect(draft.state).toBe(state);
  expect(draft.operation?.kind).toBe("checking");
  expect(later.path).toBe("dir/later.txt");
  expect(undo({ state: draft.state!, dispatch: (tr) => store.update(draft, tr.state) })).toBe(true);
  expect(draft.state!.doc.toString()).toBe("base");
  recheck.resolve(diskText({ path: "moved/a.txt", text: "base", revision: "moved" }));
  await vi.waitFor(() => expect(draft.operation).toBeUndefined());
  expect(draft.revision).toBe("moved");
});

test.each(["move", "delete"] as const)(
  "a %s issued before a save still settles its source and preserves the interrupted save target",
  async (kind) => {
    const draft = open(store, "a.txt");
    const reply = deferred<Response>();
    vi.stubGlobal("fetch", () => reply.promise);
    const running = operateFiles(store, target, kind, [item("a.txt")], {
      id: kind,
      signal: new AbortController().signal,
    });
    transport.write.mockImplementationOnce(
      (_target, _bytes, _revision, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new ApiError("io_error", "Save interrupted", "unknown")),
            { once: true },
          );
        }),
    );
    const saving = store.save(draft, { kind: "create", path: "copy.txt" });
    transport.read.mockResolvedValueOnce(
      diskText({ path: "moved/a.txt", text: "base", revision: "moved" }),
    );
    reply.resolve(
      Response.json({
        id: kind,
        outcome: "succeeded",
        result: {
          items: [{ path: "a.txt", targetPath: "moved/a.txt", outcome: "succeeded" }],
        },
      }),
    );
    expect((await running).items[0]!.outcome).toBe("succeeded");
    expect(await saving).toEqual({ kind: "ignored" });
    await vi.waitFor(() => expect(draft.operation).toBeUndefined());
    expect(draft.path).toBe(kind === "move" ? "moved/a.txt" : "a.txt");
    expect(draft.missing).toBe(kind === "delete");
    expect(draft.unknownSave).toMatchObject({ target: { path: "copy.txt" }, raw: "base" });
    expect(isDirty(draft)).toBe(true);
  },
);

test.each(["move", "delete"] as const)(
  "a late successful %s settles captured drafts after caller cancellation and ignores a replacement instance",
  async (kind) => {
    const closed = open(store, "a.txt");
    const retained = open(store, "c.txt");
    const reply = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply.promise),
    );
    transport.read.mockResolvedValueOnce(
      diskText({ path: "moved/c.txt", text: "base", revision: "base" }),
    );
    const abort = new AbortController();
    const running = operateFiles(store, target, kind, [item("a.txt"), item("c.txt")], {
      id: kind,
      signal: abort.signal,
    });
    store.close(closed);
    const replacement = open(store, "a.txt");
    abort.abort();
    const items: FileItemResult[] = ["a.txt", "c.txt"].map((path) => ({
      path,
      ...(kind === "move" ? { targetPath: `moved/${path}` } : {}),
      outcome: "succeeded",
    }));
    reply.resolve(Response.json({ id: kind, outcome: "succeeded", result: { items } }));
    expect((await running).items).toEqual(items);
    expect(store.snapshot()).toEqual([retained, replacement]);
    expect(replacement.path).toBe("a.txt");
    expect(replacement.missing).toBe(false);
    expect(retained.path).toBe(kind === "move" ? "moved/c.txt" : "c.txt");
    expect(retained.missing).toBe(kind === "delete");
    expect(retained.state!.doc.toString()).toBe("base");
    if (kind === "move") await vi.waitFor(() => expect(retained.operation).toBeUndefined());
    else expect(isDirty(retained)).toBe(true);
  },
);

test.each(["move", "delete"] as const)(
  "a late %s cannot take over a captured source recreated by a create-only save",
  async (kind) => {
    const draft = open(store, "a.txt");
    const reply = deferred<Response>();
    vi.stubGlobal("fetch", () => reply.promise);
    const running = operateFiles(store, target, kind, [item("a.txt")], {
      id: kind,
      signal: new AbortController().signal,
    });
    transport.write.mockResolvedValueOnce({ path: "a.txt", size: 4, revision: "recreated" });
    expect(await store.save(draft, { kind: "create", path: "a.txt" })).toEqual({ kind: "saved" });
    reply.resolve(
      Response.json({
        id: kind,
        outcome: "succeeded",
        result: {
          items: [
            {
              path: "a.txt",
              ...(kind === "move" ? { targetPath: "moved/a.txt" } : {}),
              outcome: "succeeded",
            },
          ],
        },
      }),
    );
    await running;
    expect(draft.path).toBe("a.txt");
    expect(draft.revision).toBe("recreated");
    expect(draft.missing).toBe(false);
    expect(transport.read).not.toHaveBeenCalled();
  },
);

test("mixed item outcomes move only successes and inspect original sources for partial or unknown results", async () => {
  const drafts = ["partial/a.txt", "unknown/b.txt", "failed.txt", "succeeded.txt"].map((path) =>
    open(store, path),
  );
  const paths = ["partial", "unknown", "failed.txt", "succeeded.txt"];
  const items: FileItemResult[] = paths.map((path, index) => ({
    path,
    targetPath: `moved/${path}`,
    outcome: (["partial", "unknown", "failed", "succeeded"] as const)[index]!,
  }));
  const error = { code: "io_error", message: "Some results are unconfirmed" };
  const inspected: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    if (request.method === "files.move")
      return Response.json({ id: request.id, outcome: "unknown", error, result: { items } });
    inspected.push(request.params.path);
    return request.params.path === "partial/a.txt"
      ? Response.json({
          id: request.id,
          outcome: "failed",
          error: { code: "not_found", message: "Removed" },
        })
      : Response.json({ id: request.id, outcome: "succeeded", result: {} });
  });
  transport.read.mockResolvedValueOnce(
    diskText({ path: "moved/succeeded.txt", text: "base", revision: "base" }),
  );
  const result = await operateFiles(
    store,
    target,
    "move",
    paths.map((path) => item(path)),
    {
      id: "mixed",
      signal: new AbortController().signal,
    },
  );
  expect(result.items).toEqual(items);
  expect(result.error).toMatchObject({ ...error, outcome: "unknown", result: { items } });
  await vi.waitFor(() => expect(drafts[0]!.missing).toBe(true));
  expect(inspected).toEqual(["partial/a.txt", "unknown/b.txt"]);
  expect(drafts.map((draft) => draft.path)).toEqual([
    "partial/a.txt",
    "unknown/b.txt",
    "failed.txt",
    "moved/succeeded.txt",
  ]);
  expect(drafts[1]!.missing).toBe(false);
  expect(drafts[2]!.missing).toBe(false);
  await vi.waitFor(() => expect(drafts[3]!.operation).toBeUndefined());
});

test.each([
  { outcome: "failed", error: { code: "busy", message: "Another operation is already running" } },
  { outcome: "unknown", error: { code: "offline", message: "Device disconnected" } },
] as const)(
  "a $outcome/$error.code batch reply without item results applies to each submitted input",
  async ({ outcome, error }) => {
    open(store, "a.txt");
    open(store, "b.txt");
    const inspected: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      if (request.method === "files.delete") {
        expect(request.params).toEqual({
          workspaceId: target.workspaceId,
          paths: ["a.txt", "b.txt"],
        });
        return Response.json({ id: request.id, outcome, error });
      }
      inspected.push(request.params.path);
      return Response.json({ id: request.id, outcome: "succeeded", result: {} });
    });
    const result = await operateFiles(store, target, "delete", [item("a.txt"), item("b.txt")], {
      id: "fallback",
      signal: new AbortController().signal,
    });
    expect(result.items).toEqual(
      ["a.txt", "b.txt"].map((path) => ({ path, targetPath: `moved/${path}`, outcome, error })),
    );
    expect(result.error).toMatchObject({ ...error, outcome });
    expect(inspected).toEqual(outcome === "failed" ? [] : ["a.txt", "b.txt"]);
  },
);

test.each(["succeeded", "unknown"] as const)(
  "a %s copy proceeds during a save without moving or probing its drafts",
  async (outcome) => {
    const draft = open(store, "a.txt");
    const saved = deferred<{ path: string; size: number; revision: string }>();
    transport.write.mockReturnValueOnce(saved.promise);
    const saving = store.save(draft, { kind: "create", path: "copy.txt" });
    const request = draft.operation;
    const error = { code: "io_error", message: "Copy result is unconfirmed" };
    const fetch = vi.fn(async () =>
      Response.json({
        id: "copy",
        outcome,
        ...(outcome === "unknown" ? { error } : {}),
        result: {
          items: [
            {
              path: "a.txt",
              targetPath: "copy.txt",
              outcome,
              ...(outcome === "unknown" ? { error } : {}),
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await operateFiles(
      store,
      target,
      "copy",
      [{ ...item("a.txt", "copy.txt"), collision: "replace", expectedTargetVersion: "confirmed" }],
      { id: "copy", signal: new AbortController().signal },
    );
    expect(result.items[0]!.outcome).toBe(outcome);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(draft.path).toBe("a.txt");
    expect(draft.operation).toBe(request);
    expect(transport.read).not.toHaveBeenCalled();
    saved.resolve({ path: "copy.txt", size: 4, revision: "saved" });
    expect(await saving).toEqual({ kind: "saved" });
  },
);

test("an HTTP conflict fails each input without probing its draft", async () => {
  const draft = open(store, "a.txt");
  const error = { code: "conflict", message: "Request is already in progress" };
  const fetch = vi.fn(async () => Response.json({ error }, { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  const result = await operateFiles(store, target, "delete", [item("a.txt")], {
    id: "http-conflict",
    signal: new AbortController().signal,
  });
  expect(result.items).toEqual([{ path: "a.txt", targetPath: "moved/a.txt", outcome: "failed" }]);
  expect(result.error).toMatchObject({ ...error, outcome: undefined });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(draft.path).toBe("a.txt");
  expect(draft.missing).toBe(false);
  expect(transport.read).not.toHaveBeenCalled();
});

test("a network failure leaves each input unknown and probes its original draft path", async () => {
  const draft = open(store, "a.txt");
  const inspected: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    if (request.method === "files.delete") throw new TypeError("Failed to fetch");
    inspected.push(request.params.path);
    return Response.json({ id: request.id, outcome: "succeeded", result: {} });
  });
  const result = await operateFiles(store, target, "delete", [item("a.txt")], {
    id: "network-failure",
    signal: new AbortController().signal,
  });
  expect(result.items).toEqual([{ path: "a.txt", targetPath: "moved/a.txt", outcome: "unknown" }]);
  expect(result.error).toMatchObject({
    code: "io_error",
    message: "No operation result was received",
    outcome: "unknown",
  });
  expect(inspected).toEqual(["a.txt"]);
  expect(draft.path).toBe("a.txt");
  expect(draft.missing).toBe(false);
  expect(transport.read).not.toHaveBeenCalled();
});
