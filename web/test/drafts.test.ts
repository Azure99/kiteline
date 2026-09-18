import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Device } from "@kiteline/shared/protocol";
import { DraftStore, draftError, isDirty } from "../src/files/drafts";
import { ApiError } from "../src/lib/api";
import type { DiskText, FileTarget } from "../src/files/content";

const transport = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../src/files/content", () => ({ readText: transport.read, writeText: transport.write }));
const target: FileTarget = { deviceId: "device", workspaceId: "workspace", path: "a.txt" };
function disk(text: string, revision: string, path = "a.txt"): DiskText {
  return {
    target: { ...target, path },
    text,
    raw: text,
    meta: {
      size: text.length,
      contentType: "text/plain",
      filename: path,
      revision,
      bom: false,
      lineEnding: "lf",
    },
  };
}
async function opened() {
  const store = new DraftStore();
  store.limits([{ id: "device", editorBytes: 1024 } as Device], 4096);
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  const draft = store.open({ ...target, deviceName: "Device", workspaceName: "Workspace" });
  await vi.waitFor(() => expect(draft.state).toBeDefined());
  return { store, draft };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

test("save retains later typing and unknown save-as checks its submitted target", async () => {
  const { store, draft } = await opened();
  let finish!: (value: unknown) => void;
  transport.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = store.save(draft);
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " later" } }).state);
  finish({ path: "a.txt", revision: "saved", size: 4 });
  await saving;
  expect(draft.baseText).toBe("base");
  expect(draft.state!.doc.toString()).toBe("base later");
  expect(isDirty(draft)).toBe(true);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost result", "unknown"));
  await store.save(draft, "copy.txt", null);
  transport.read.mockResolvedValueOnce(disk("base later", "copy", "copy.txt"));
  await store.check(draft);
  expect(transport.read.mock.calls.at(-1)?.[0].path).toBe("copy.txt");
  expect(draft.path).toBe("copy.txt");
  expect(isDirty(draft)).toBe(false);
});

test("old save confirmation cannot replace a newer baseline after a rename round trip", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 0, to: 4, insert: "first" } }).state);
  let finish!: (value: unknown) => void;
  transport.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = store.save(draft);
  transport.read.mockResolvedValueOnce(disk("first", "b-first", "b.txt"));
  await store.rename("device", "workspace", "a.txt", "b.txt");
  transport.read.mockResolvedValueOnce(disk("first", "a-first"));
  await store.rename("device", "workspace", "b.txt", "a.txt");
  store.update(draft, draft.state!.update({ changes: { from: 0, to: 5, insert: "second" } }).state);
  transport.write.mockResolvedValueOnce({ path: "a.txt", revision: "second", size: 6 });
  await store.save(draft, "a.txt", "a-first");
  finish({ path: "a.txt", revision: "first", size: 5 });
  await saving;
  expect(draft.baseText).toBe("second");
  expect(draft.revision).toBe("second");
});

test("closed drafts stay closed after a late read; lower limits allow shrinking and compliant saves", async () => {
  const { store, draft } = await opened();
  store.limits([{ id: "device", editorBytes: 3 } as Device], 2);
  expect(store.canSave(draft)).toBe(false);
  expect(store.limitError(draft, 5)).toBeTruthy();
  expect(store.limitError(draft, 3)).toBeUndefined();
  store.update(draft, draft.state!.update({ changes: { from: 3, to: 4 } }).state);
  expect(store.canSave(draft)).toBe(true);
  store.close(draft);
  let finish!: (value: unknown) => void;
  transport.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const next = store.open({ ...target, deviceName: "Device", workspaceName: "Workspace" });
  store.close(next);
  finish(disk("a", "late"));
  await Promise.resolve();
  expect(store.snapshot()).toEqual([]);
  expect(next.state).toBeUndefined();
});

test("deleting an open file invalidates a late save while preserving its text", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " edited" } }).state);
  let finish!: (value: unknown) => void;
  transport.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = store.save(draft);
  store.deleted("device", "workspace", "a.txt");
  finish({ path: "a.txt", revision: "late", size: 11 });
  expect(await saving).toBe(false);
  expect(draft.baseText).toBe("base");
  expect(draft.state!.doc.toString()).toBe("base edited");
  expect(isDirty(draft)).toBe(true);
});

test("missing checks cannot override later same-path saves or another open draft", async () => {
  const { store, draft } = await opened();
  transport.read.mockResolvedValueOnce(disk("target", "b-target", "b.txt"));
  const duplicate = store.open({
    ...target,
    path: "b.txt",
    deviceName: "Device",
    workspaceName: "Workspace",
  });
  await vi.waitFor(() => expect(duplicate.state).toBeDefined());
  transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
  await store.rename("device", "workspace", "a.txt", "b.txt");
  for (const savedDraft of [draft, duplicate]) {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        )
        .mockImplementation(() =>
          Promise.resolve(Response.json({ outcome: "succeeded", result: {} })),
        ),
    );
    const checking = store.checkMissing("device", "workspace", "b.txt");
    transport.write.mockResolvedValueOnce({
      path: "b.txt",
      revision: savedDraft.revision,
      size: savedDraft.bytes,
    });
    expect(await store.save(savedDraft, "b.txt", null)).toBe(true);
    finish(
      Response.json({
        outcome: "failed",
        error: { code: "not_found", message: "missing before save" },
      }),
    );
    await checking;
    expect(savedDraft.missing).toBe(false);
    expect(isDirty(savedDraft)).toBe(false);
  }
});
test("background observations preserve edits, recover missing status and cannot undo a later deletion", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " edited" } }).state);
  const state = draft.state;
  const signal = new AbortController().signal;
  transport.read.mockResolvedValueOnce(disk("external", "external"));
  await store.observe(draft, signal);
  expect(draft.state).toBe(state);
  expect(draft.revision).toBe("a-base");
  expect(draft.diskChanged).toBe(true);
  transport.read.mockRejectedValueOnce(new ApiError("not_found", "missing"));
  await store.observe(draft, signal);
  expect(draft.missing).toBe(true);
  expect(draftError(draft)).toBe("missing");
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  await store.observe(draft, signal);
  expect(draft.missing).toBe(false);
  expect(draftError(draft)).toBeUndefined();
  expect(draft.state).toBe(state);
  let finish!: (value: DiskText) => void;
  transport.read.mockImplementationOnce(
    () =>
      new Promise<DiskText>((resolve) => {
        finish = resolve;
      }),
  );
  const observing = store.observe(draft, signal);
  store.deleted("device", "workspace", "a.txt");
  finish(disk("base", "a-base"));
  await observing;
  expect(draft.missing).toBe(true);
  expect(draft.state).toBe(state);
});
