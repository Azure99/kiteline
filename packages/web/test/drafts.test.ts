import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { StateEffect, type Transaction } from "@codemirror/state";
import { getSearchQuery, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { AgentEnvironment, Device } from "@kiteline/shared/protocol";
import { DraftStore, draftProblem, isDirty } from "../src/files/drafts";
import { renameFile } from "../src/files/actions";
import { ApiError } from "../src/lib/api";
import type { DiskText, FileTarget } from "../src/files/content";
import { LanguageDescription, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { completeDraftClose } from "../src/files/close-draft";

const transport = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../src/files/content", () => ({
  readText: transport.read,
  writeText: transport.write,
}));
const target: FileTarget = { deviceId: "device", workspaceId: "workspace", path: "a.txt" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function disk(text: string, revision: string, path = "a.txt"): DiskText {
  return {
    target: { ...target, path },
    text,
    raw: text,
    meta: {
      size: Buffer.byteLength(text),
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
  store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  const draft = store.open({ ...target, deviceName: "Device", workspaceName: "Workspace" });
  await vi.waitFor(() => expect(draft.state).toBeDefined());
  return { store, draft };
}
function untitled(os?: AgentEnvironment["os"]) {
  const store = new DraftStore();
  store.observeDevices([{ id: "device", editorBytes: 1024, environment: { os } } as Device]);
  const draft = store.open({
    ...target,
    path: "",
    folder: "dir",
    deviceName: "Device",
    workspaceName: "Workspace",
  });
  return { store, draft };
}
function browserAt(path: string) {
  const browser = Object.assign(new EventTarget(), {
    location: new URL(path, "https://kiteline.test"),
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("PopStateEvent", Event);
  vi.stubGlobal("history", {
    replaceState: vi.fn((_state: unknown, _title: string, path: string) => {
      browser.location = new URL(path, browser.location);
    }),
    pushState: vi.fn(),
  });
  return browser;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

test("preloaded open adopts once and never replaces an existing editor or its undo state", () => {
  const store = new DraftStore();
  store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
  const named = { ...target, deviceName: "Device", workspaceName: "Workspace" };
  const draft = store.open(named, disk("base", "first"));
  const edited = draft.state!.update({ changes: { from: 4, insert: " edited" } }).state;
  store.update(draft, edited);
  expect(store.open(named, disk("late disk", "second"))).toBe(draft);
  expect(draft.state).toBe(edited);
  expect(draft.revision).toBe("first");
  expect(transport.read).not.toHaveBeenCalled();
});

test("new drafts are distinct, have no disk source, and closing from a directory stays there", async () => {
  const { store, draft } = untitled();
  const second = store.open({
    ...target,
    path: "",
    deviceName: "Device",
    workspaceName: "Workspace",
  });
  expect(second.id).not.toBe(draft.id);
  expect(draft.state!.doc.toString()).toBe("");
  expect(isDirty(draft)).toBe(false);
  expect(store.find({ ...target, path: "" })).toBeUndefined();
  expect(store.find({ ...target, path: "" }, second.id)).toBe(second);
  await store.observe(draft, new AbortController().signal);
  expect(transport.read).not.toHaveBeenCalled();
  const browser = browserAt("/devices/device/workspaces/workspace/files?folder=dir");
  completeDraftClose(store, draft);
  expect(browser.location.search).toBe("?folder=dir");
  expect(store.snapshot()).toEqual([second]);
});

test("first save keeps a conflicting draft, then adopts its new path without losing later edits", async () => {
  const { store, draft } = untitled("windows");
  store.update(draft, draft.state!.update({ changes: { from: 0, insert: "sent" } }).state);
  const id = draft.id;
  const conflict = new ApiError("conflict", "The path already exists");
  transport.write.mockRejectedValueOnce(conflict);
  expect(await store.save(draft, { kind: "create", path: "dir/taken.ps1" })).toEqual({
    kind: "conflict",
    error: conflict,
  });
  expect(draft.path).toBe("");
  expect(draft.format.bom).toBe(false);
  expect(draft.error).toBe(conflict);
  expect(isDirty(draft)).toBe(true);
  const pending = deferred<{ path: string; size: number; revision: string }>();
  transport.write.mockReturnValueOnce(pending.promise);
  const saving = store.save(draft, { kind: "create", path: "dir/new.PS1" });
  const [, bytes, revision] = transport.write.mock.calls[1]!;
  expect(Buffer.from(bytes)).toEqual(Buffer.from("\uFEFFsent"));
  expect(revision).toBeUndefined();
  const edited = draft.state!.update({ changes: { from: 4, insert: " later" } }).state;
  store.update(draft, edited);
  pending.resolve({ path: "dir/new.PS1", size: 7, revision: "first" });
  expect(await saving).toEqual({ kind: "saved" });
  expect(draft.id).toBe(id);
  expect(draft.path).toBe("dir/new.PS1");
  expect(draft.state).toBe(edited);
  expect(draft.baseText).toBe("sent");
  expect(isDirty(draft)).toBe(true);
  expect(draft.format.bom).toBe(true);
  expect(draft.bytes).toBe(Buffer.byteLength("\uFEFFsent later"));
  transport.write.mockResolvedValueOnce({ path: draft.path, revision: "second" });
  expect(await store.save(draft)).toEqual({ kind: "saved" });
  expect(Buffer.from(transport.write.mock.lastCall![1])).toEqual(Buffer.from("\uFEFFsent later"));
});

test("unstarted saves and checks preserve an earlier conflict without reporting it as their result", async () => {
  const { store, draft } = await opened();
  const conflict = new ApiError("conflict", "An earlier save conflicted");
  draft.error = conflict;
  store.observeDevices([{ id: "device", editorBytes: 3 } as Device]);
  expect(await store.save(draft)).toEqual({ kind: "ignored" });
  expect(draft.error).toBe(conflict);
  expect(transport.write).not.toHaveBeenCalled();
  store.close(draft);
  expect(await store.check(draft)).toEqual({ kind: "ignored" });
  expect(draft.error).toBe(conflict);
  expect(transport.read).toHaveBeenCalledTimes(1);
});

test("late save failures belong to the interrupted request and do not replace a moved draft's error", async () => {
  const { store, draft } = await opened();
  const response = deferred<unknown>();
  transport.write.mockReturnValueOnce(response.promise);
  const saving = store.save(draft);
  transport.read.mockResolvedValueOnce(disk("base", "moved", "b.txt"));
  await store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
  const currentError = new ApiError("io_error", "A later operation failed");
  draft.error = currentError;
  response.resolve(Promise.reject(new ApiError("conflict", "The old target changed")));
  expect(await saving).toEqual({ kind: "ignored" });
  expect(draft.path).toBe("b.txt");
  expect(draft.error).toBe(currentError);
});

test("a failed save and check each return their own error and preserve the transport outcome", async () => {
  const { store, draft } = await opened();
  const failure = new ApiError("io_error", "The transport failed without a known outcome");
  transport.write.mockRejectedValueOnce(failure);
  const saved = await store.save(draft);
  const readError = new ApiError("not_found", "The source is missing");
  transport.read.mockRejectedValueOnce(readError);
  expect(await store.check(draft)).toEqual({ kind: "failed", error: readError });
  expect(draft.error).toBe(readError);
  expect(saved).toEqual({ kind: "failed", error: failure });
  expect(failure.outcome).toBeUndefined();
});

test("device observations retain known capacity and select first-save encoding by the draft's device", async () => {
  const { store, draft } = untitled("windows");
  store.observeDevices([{ id: "other", editorBytes: 7, environment: { os: "linux" } } as Device]);
  store.observeDevices([{ id: "device", editorBytes: 7 } as Device]);
  store.observeDevices([{ id: "device" } as Device]);
  const other = store.open({
    ...target,
    deviceId: "other",
    path: "",
    deviceName: "Other",
    workspaceName: "Workspace",
  });
  for (const current of [draft, other]) {
    store.update(current, current.state!.update({ changes: { from: 0, insert: "sent" } }).state);
    transport.write.mockResolvedValueOnce({ path: "new.ps1", revision: "saved" });
    expect(await store.save(current, { kind: "create", path: "new.ps1" })).toEqual({
      kind: "saved",
    });
  }
  expect(Buffer.from(transport.write.mock.calls[0]![1])).toEqual(Buffer.from("\uFEFFsent"));
  expect(Buffer.from(transport.write.mock.calls[1]![1])).toEqual(Buffer.from("sent"));
});

test("an unknown first save checks its submitted path and keeps subsequent edits", async () => {
  const { store, draft } = untitled("windows");
  const written: FileTarget[] = [];
  window.addEventListener("kiteline:file-written", (event) => written.push(event.detail));
  store.update(draft, draft.state!.update({ changes: { from: 0, insert: "sent" } }).state);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
  expect(await store.save(draft, { kind: "create", path: "dir/new.ps1" })).toMatchObject({
    kind: "failed",
    error: { outcome: "unknown" },
  });
  expect(draft.path).toBe("");
  expect(draft.format.bom).toBe(false);
  expect(draft.unknownSave?.target.path).toBe("dir/new.ps1");
  const edited = draft.state!.update({ changes: { from: 4, insert: " later" } }).state;
  store.update(draft, edited);
  const saved = disk("sent", "first", "dir/new.ps1");
  saved.raw = "\uFEFFsent";
  saved.meta.bom = true;
  saved.meta.size = 7;
  transport.read.mockResolvedValueOnce(saved);
  expect(await store.check(draft)).toEqual({ kind: "confirmed-save", disk: saved });
  expect(transport.read.mock.calls[0]![0]).toEqual({ ...target, path: "dir/new.ps1" });
  expect(draft.path).toBe("dir/new.ps1");
  expect(draft.unknownSave).toBeUndefined();
  expect(draft.state).toBe(edited);
  expect(draft.baseText).toBe("sent");
  expect(isDirty(draft)).toBe(true);
  expect(draft.format.bom).toBe(true);
  expect(draft.bytes).toBe(Buffer.byteLength("\uFEFFsent later"));
  expect(written).toEqual([{ ...target, path: "dir/new.ps1" }]);
  transport.read.mockResolvedValueOnce(saved);
  expect(await store.check(draft)).toEqual({ kind: "read", disk: saved, unconfirmedSave: false });
  expect(written).toHaveLength(1);
  transport.write.mockResolvedValueOnce({ path: draft.path, revision: "second" });
  expect(await store.save(draft)).toEqual({ kind: "saved" });
  expect(Buffer.from(transport.write.mock.lastCall![1])).toEqual(Buffer.from("\uFEFFsent later"));
});

test.each([6, 7])("a new Windows script counts its BOM against a %i-byte limit", async (limit) => {
  const { store, draft } = untitled("windows");
  store.observeDevices([{ id: "device", editorBytes: limit } as Device]);
  store.update(draft, draft.state!.update({ changes: { from: 0, insert: "sent" } }).state);
  transport.write.mockResolvedValueOnce({ path: "new.ps1", revision: "saved" });
  expect(await store.save(draft, { kind: "create", path: "new.ps1" })).toMatchObject({
    kind: limit === 7 ? "saved" : "failed",
  });
  if (limit === 6) {
    expect(transport.write).not.toHaveBeenCalled();
    expect(draft.error).toMatchObject({ code: "limit_exceeded" });
    expect(draft.format.bom).toBe(false);
    expect(draft.bytes).toBe(4);
  } else {
    expect(Buffer.from(transport.write.mock.lastCall![1])).toEqual(Buffer.from("\uFEFFsent"));
    expect(draft.bytes).toBe(7);
  }
});

test("confirming a Windows script keeps later edits that now exceed capacity", async () => {
  const { store, draft } = untitled("windows");
  store.observeDevices([{ id: "device", editorBytes: 7 } as Device]);
  store.update(draft, draft.state!.update({ changes: { from: 0, insert: "sent" } }).state);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
  await store.save(draft, { kind: "create", path: "new.ps1" });
  const edited = draft.state!.update({ changes: { from: 4, insert: "++" } }).state;
  store.update(draft, edited);
  const saved = disk("sent", "first", "new.ps1");
  saved.raw = "\uFEFFsent";
  saved.meta.bom = true;
  saved.meta.size = 7;
  transport.read.mockResolvedValueOnce(saved);
  await store.check(draft);
  expect(draft.state).toBe(edited);
  expect(draft.bytes).toBe(9);
  expect(store.canSave(draft)).toBe(false);
  expect(store.acceptEdit(draft, 7)).toBe(true);
  store.update(draft, edited.update({ changes: { from: 4, to: 6 } }).state);
  expect(store.canSave(draft)).toBe(true);
});

test("a different disk version after an unknown first save can be overwritten with a BOM", async () => {
  const { store, draft } = untitled("windows");
  store.update(draft, draft.state!.update({ changes: { from: 0, insert: "sent" } }).state);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
  await store.save(draft, { kind: "create", path: "new.ps1" });
  transport.read.mockResolvedValueOnce(disk("external", "external-version", "new.ps1"));
  const current = await store.check(draft);
  expect(current.kind).toBe("read");
  if (current.kind !== "read")
    throw new Error("The different disk version must remain unconfirmed");
  expect(current.unconfirmedSave).toBe(true);
  expect(draft.path).toBe("");
  expect(draft.format.bom).toBe(false);
  transport.write.mockResolvedValueOnce({ path: "new.ps1", revision: "saved" });
  expect(
    await store.save(draft, {
      kind: "overwrite",
      path: current.disk.target.path,
      revision: current.disk.meta.revision!,
    }),
  ).toEqual({ kind: "saved" });
  expect(Buffer.from(transport.write.mock.lastCall![1])).toEqual(Buffer.from("\uFEFFsent"));
});

test.each([
  ["linux", "new.ps1"],
  ["macos", "new.ps1"],
  [undefined, "new.ps1"],
  ["windows", "new.txt"],
] as const)("a new %s target named %s keeps its original format", async (os, path) => {
  const { store, draft } = untitled(os);
  store.update(draft, draft.state!.update({ changes: { from: 0, insert: "plain" } }).state);
  transport.write.mockResolvedValueOnce({ path, revision: "saved" });
  expect(await store.save(draft, { kind: "create", path })).toEqual({ kind: "saved" });
  expect(Buffer.from(transport.write.mock.lastCall![1])).toEqual(Buffer.from("plain"));
  expect(draft.format.bom).toBe(false);
});

test.each(["existing.ps1", "copy.ps1"])(
  "an existing Windows script saved to %s keeps no BOM",
  async (path) => {
    const { store, draft } = await opened();
    store.observeDevices([{ id: "device", environment: { os: "windows" } } as Device]);
    store.replaceSource(draft, disk("existing", "original", "existing.ps1"));
    transport.write.mockResolvedValueOnce({ path, revision: "saved" });
    expect(
      await store.save(
        draft,
        path === draft.path
          ? { kind: "overwrite", path, revision: draft.revision! }
          : { kind: "create", path },
      ),
    ).toEqual({ kind: "saved" });
    expect(Buffer.from(transport.write.mock.lastCall![1])).toEqual(Buffer.from("existing"));
    expect(draft.format.bom).toBe(false);
  },
);

test("closing a duplicate-path draft does not clear the file-only target of another draft", async () => {
  const { store, draft } = await opened();
  transport.read.mockResolvedValueOnce(disk("other", "b", "b.txt"));
  const duplicate = store.open({
    ...target,
    path: "b.txt",
    deviceName: "Device",
    workspaceName: "Workspace",
  });
  await vi.waitFor(() => expect(duplicate.state).toBeDefined());
  store.replaceSource(duplicate, disk("other", "moved", "a.txt"));
  const browser = browserAt("/devices/device/workspaces/workspace/git?file=a.txt&repo=r");
  completeDraftClose(store, duplicate);
  expect(browser.location.searchParams.get("file")).toBe("a.txt");
  expect(store.find(target)).toBe(draft);
  completeDraftClose(store, draft);
  expect(browser.location.searchParams.has("file")).toBe(false);
  expect(browser.location.pathname.endsWith("/git")).toBe(true);
  expect(browser.location.searchParams.get("repo")).toBe("r");
});

test("a closed draft identity cannot resolve or close a later draft at the same path", async () => {
  const { store, draft } = await opened();
  store.close(draft);
  const later = store.open(
    { ...target, deviceName: "Device", workspaceName: "Workspace" },
    disk("later", "later"),
  );
  expect(store.find(target, draft.id)).toBeUndefined();
  expect(store.find(target)).toBe(later);
  const browser = browserAt(
    `/devices/device/workspaces/workspace/files?file=a.txt&draft=${later.id}`,
  );
  completeDraftClose(store, draft);
  expect(browser.location.searchParams.get("draft")).toBe(later.id);
  expect(store.has(later)).toBe(true);
});

test("a moved source retains the disk-change fact alongside a duplicate-target notice", async () => {
  const { store, draft } = await opened();
  store.open(
    { ...target, path: "b.txt", deviceName: "Device", workspaceName: "Workspace" },
    disk("other draft", "other", "b.txt"),
  );
  transport.read.mockResolvedValueOnce(disk("external", "moved", "b.txt"));
  await store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
  expect(draft.diskChanged).toBe(true);
  expect(draft.notice).toBe("duplicateDraft");
  expect(draft.state!.doc.toString()).toBe("base");
  expect(draft.baseRaw).toBe("base");
});

test("closing the active draft clears only its target so the workspace can choose the next page", () => {
  const store = new DraftStore();
  store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
  const named = { ...target, deviceName: "Device", workspaceName: "Workspace" };
  const a = store.open(named, disk("a", "a"));
  const b = store.open({ ...named, path: "b.txt" }, disk("b", "b", "b.txt"));
  const browser = browserAt(
    `/devices/device/workspaces/workspace/files?file=b.txt&draft=${b.id}&session=s`,
  );
  completeDraftClose(store, b);
  expect(browser.location.searchParams.has("file")).toBe(false);
  expect(browser.location.searchParams.has("draft")).toBe(false);
  expect(browser.location.searchParams.get("session")).toBe("s");
  expect(store.snapshot()).toEqual([a]);
  expect(history.replaceState).toHaveBeenCalledTimes(1);
  expect(history.pushState).not.toHaveBeenCalled();
});

test.each(["files", "git"])("background close preserves the %s tool and query", (tool) => {
  const store = new DraftStore();
  store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
  const named = { ...target, deviceName: "Device", workspaceName: "Workspace" };
  const a = store.open(named, disk("a", "a"));
  const b = store.open({ ...named, path: "b.txt" }, disk("b", "b", "b.txt"));
  const browser = browserAt(
    `/devices/device/workspaces/workspace/${tool}?file=b.txt&draft=${b.id}&search=1&folder=dir&repo=r&session=s&reveal=dir/target.txt`,
  );
  const expected = new URL(browser.location);
  expected.searchParams.delete("file");
  expected.searchParams.delete("draft");
  completeDraftClose(store, b);
  expect(store.has(a)).toBe(true);
  expect(browser.location.pathname).toBe(expected.pathname);
  expect(Object.fromEntries(browser.location.searchParams)).toEqual(
    Object.fromEntries(expected.searchParams),
  );
  expect(history.replaceState).toHaveBeenCalledTimes(1);
  expect(history.pushState).not.toHaveBeenCalled();
});

test("saving adopts the returned logical target while preserving later typing and undo", async () => {
  const { store, draft } = await opened();
  const original = disk("base", "a-base");
  original.meta.resolvedPath = "/workspace/a.txt";
  store.replaceSource(draft, original);
  const pending = deferred<{ path: string; size: number; revision: string }>();
  transport.write.mockReturnValueOnce(pending.promise);
  const saving = store.save(draft, { kind: "create", path: "PARENT/copy.txt" });
  const edited = draft.state!.update({ changes: { from: 4, insert: " later" } }).state;
  store.update(draft, edited);
  pending.resolve({ path: "Parent/copy.txt", size: 4, revision: "copy" });
  expect(await saving).toEqual({ kind: "saved" });
  expect(draft.path).toBe("Parent/copy.txt");
  expect(draft.resolvedPath).toBeUndefined();
  expect(draft.state).toBe(edited);
  expect(draft.baseText).toBe("base");
  expect(isDirty(draft)).toBe(true);
  transport.read.mockResolvedValueOnce(disk("base", "copy", "Parent/copy.txt"));
  await store.observe(draft, new AbortController().signal);
  expect(draft.resolvedPath).toBeUndefined();
  expect(draft.state).toBe(edited);
});

test.each([
  { requested: "a.txt", returned: "a.txt", revision: "a-base", keepsResolvedPath: true },
  { requested: "a.txt", returned: "a.txt", revision: null, keepsResolvedPath: true },
  { requested: "A.txt", returned: "a.txt", revision: null, keepsResolvedPath: true },
  { requested: "a.txt", returned: "canonical.txt", revision: "a-base", keepsResolvedPath: false },
])(
  "saving $requested as $returned with revision $revision invalidates only a changed logical path",
  async ({ requested, returned, revision, keepsResolvedPath }) => {
    const { store, draft } = await opened();
    const original = disk("base", "a-base");
    original.meta.resolvedPath = "/workspace/a.txt";
    store.replaceSource(draft, original);
    transport.write.mockResolvedValueOnce({ path: returned, revision: "saved", size: 4 });
    expect(
      await store.save(
        draft,
        revision === null
          ? { kind: "create", path: requested }
          : { kind: "overwrite", path: requested, revision },
      ),
    ).toEqual({ kind: "saved" });
    expect(draft.path).toBe(returned);
    expect(draft.resolvedPath).toBe(keepsResolvedPath ? original.meta.resolvedPath : undefined);
  },
);

test("a save completed after its draft closes still notifies the actual saved target", async () => {
  const { store, draft } = await opened();
  const written: FileTarget[] = [];
  window.addEventListener("kiteline:file-written", (event) => written.push(event.detail));
  const pending = deferred<{ path: string; size: number; revision: string }>();
  transport.write.mockReturnValueOnce(pending.promise);
  const saving = store.save(draft, { kind: "create", path: "PARENT/copy.txt" });
  store.close(draft);
  pending.resolve({ path: "Parent/copy.txt", size: 4, revision: "copy" });
  expect(await saving).toEqual({ kind: "ignored" });
  expect(store.snapshot()).toEqual([]);
  expect(written).toEqual([{ ...target, path: "Parent/copy.txt" }]);
});

test.each(["closed", "interrupted"])(
  "an equal unknown-save read rejected after its draft is %s does not notify a write",
  async (reason) => {
    const { store, draft } = await opened();
    const written: FileTarget[] = [];
    window.addEventListener("kiteline:file-written", (event) => written.push(event.detail));
    transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
    expect(await store.save(draft, { kind: "create", path: "copy.txt" })).toMatchObject({
      kind: "failed",
      error: { outcome: "unknown" },
    });
    const pending = deferred<DiskText>();
    transport.read.mockReturnValueOnce(pending.promise);
    const checking = store.check(draft);
    if (reason === "closed") {
      store.close(draft);
      store.open(
        { ...target, deviceName: "Device", workspaceName: "Workspace" },
        disk("replacement", "replacement"),
      );
    } else store.deleted(store.capture(target.deviceId, target.workspaceId, target.path));
    pending.resolve(disk("base", "copy", "copy.txt"));
    expect(await checking).toEqual({ kind: "ignored" });
    expect(draft.unknownSave).toBeDefined();
    expect(store.find(target)?.path).toBe("a.txt");
    expect(written).toEqual([]);
  },
);

test("reloading a draft retains its loaded language support", async () => {
  const { store, draft } = await opened();
  const support = await LanguageDescription.matchFilename(languages, "a.js")!.load();
  store.update(draft, draft.state!.update({ effects: draft.language.reconfigure(support) }).state);
  store.replaceSource(draft, disk("const count = 2;", "reloaded", "a.js"));
  expect(draft.state!.doc.toString()).toBe("const count = 2;");
  expect(syntaxTree(draft.state!).topNode.name).toBe("Script");
  expect(syntaxTree(draft.state!).toString()).toContain("VariableDeclaration");
});

test("save retains later typing and unknown save-as checks its submitted target", async () => {
  const { store, draft } = await opened();
  const original = disk("base", "a-base");
  original.meta.resolvedPath = "/workspace/a.txt";
  store.replaceSource(draft, original);
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
  await store.save(draft, { kind: "create", path: "copy.txt" });
  const copy = disk("base later", "copy", "copy.txt");
  copy.meta.resolvedPath = "/workspace/copy.txt";
  transport.read.mockResolvedValueOnce(copy);
  await store.check(draft);
  expect(transport.read).toHaveBeenLastCalledWith(
    { ...target, path: "copy.txt" },
    expect.any(AbortSignal),
  );
  expect(draft.path).toBe("copy.txt");
  expect(draft.resolvedPath).toBe("/workspace/copy.txt");
  expect(isDirty(draft)).toBe(false);
});

test.each([
  { original: "a.txt", saved: "a.txt", from: "a.txt", to: "b.txt", final: "b.txt" },
  {
    original: "dir/a.txt",
    saved: "dir/copy.txt",
    from: "dir",
    to: "moved",
    final: "moved/copy.txt",
  },
  { original: "dir/a.txt", saved: "copy.txt", from: "dir", to: "moved", final: "copy.txt" },
  {
    original: "a.txt",
    requested: "PARENT/copy.txt",
    saved: "Parent/copy.txt",
    from: "Parent/copy.txt",
    to: "Parent/moved.txt",
    final: "Parent/moved.txt",
  },
  {
    original: "a.txt",
    saved: "copy.txt",
    from: "copy.txt",
    to: "renamed.txt",
    final: "renamed.txt",
  },
])(
  "save to $saved blocks rename $from until its reply, then preserves the editor on move",
  async (paths) => {
    const root = await mkdtemp(join(tmpdir(), "kiteline-draft-save-"));
    const store = new DraftStore();
    store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
    const release = deferred<void>();
    try {
      const read = async (target: FileTarget) => {
        const raw = await readFile(join(root, target.path), "utf8");
        return disk(
          raw,
          createHash("sha256").update(target.path).update(raw).digest("hex"),
          target.path,
        );
      };
      await mkdir(dirname(join(root, paths.original)), { recursive: true });
      await mkdir(dirname(join(root, paths.saved)), { recursive: true });
      await writeFile(join(root, paths.original), "base");
      transport.read.mockImplementation(read);
      const draft = store.open(
        { ...target, path: paths.original, deviceName: "Device", workspaceName: "Workspace" },
        await read({ ...target, path: paths.original }),
      );
      store.update(
        draft,
        draft.state!.update({ changes: { from: 0, to: 4, insert: "sent" } }).state,
      );
      const published = deferred<void>();
      transport.write.mockImplementationOnce(
        async (
          _target: FileTarget,
          bytes: Uint8Array,
          _revision,
          _signal,
          prepared?: (path: string) => void,
        ) => {
          const target = { ..._target, path: paths.saved };
          prepared?.(target.path);
          await writeFile(join(root, target.path), bytes);
          const result = {
            path: target.path,
            revision: (await read(target)).meta.revision,
            size: bytes.length,
          };
          published.resolve();
          await release.promise;
          return result;
        },
      );
      const saving = store.save(draft, {
        kind: "create",
        path: paths.requested ?? paths.saved,
      });
      await published.promise;
      store.update(
        draft,
        draft.state!.update({
          changes: { from: 4, insert: " later" },
          selection: { anchor: 5, head: 10 },
          annotations: isolateHistory.of("full"),
        }).state,
      );
      const scrollSnapshot = { line: 1, column: 5, offsetX: -2, offsetY: -3 };
      draft.view.scrollSnapshot = scrollSnapshot;
      vi.stubGlobal("fetch", async () => {
        await rename(join(root, paths.from), join(root, paths.to));
        return Response.json({ outcome: "succeeded", result: { from: paths.from, to: paths.to } });
      });
      await expect(
        renameFile(store, { ...target, path: paths.from }, paths.to),
      ).rejects.toMatchObject({ code: "busy" });
      expect(store.savingWithin("device", "workspace", paths.from)).toBe(true);
      expect(store.savingWithin("other", "workspace", paths.from)).toBe(false);
      release.resolve();
      expect(await saving).toEqual({ kind: "saved" });
      await renameFile(store, { ...target, path: paths.from }, paths.to);
      await vi.waitFor(() => expect(draft.operation).toBeUndefined());
      expect(draft.path).toBe(paths.final);
      expect(draft.baseRaw).toBe("sent");
      expect(draft.revision).toBe((await read({ ...target, path: paths.final })).meta.revision);
      expect(draft.state!.doc.toString()).toBe("sent later");
      expect(draft.state!.selection.main).toMatchObject({ anchor: 5, head: 10 });
      expect(draft.view.scrollSnapshot).toEqual(scrollSnapshot);
      expect(draft.unknownSave).toBeUndefined();
      expect(undo({ state: draft.state!, dispatch: (tr) => store.update(draft, tr.state) })).toBe(
        true,
      );
      expect(draft.state!.doc.toString()).toBe("sent");
      expect(isDirty(draft)).toBe(false);
      expect(redo({ state: draft.state!, dispatch: (tr) => store.update(draft, tr.state) })).toBe(
        true,
      );
      expect(draft.state!.doc.toString()).toBe("sent later");
      expect(draft.baseText).toBe("sent");
    } finally {
      release.resolve();
      store.clear();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("stale moved-source reads cannot survive rename round trips or a closed draft", async () => {
  const { store, draft } = await opened();
  const firstRead = deferred<DiskText>();
  transport.read.mockReturnValueOnce(firstRead.promise);
  const firstRename = store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
  await vi.waitFor(() => expect(transport.read.mock.calls.at(-1)?.[0].path).toBe("b.txt"));
  transport.read.mockResolvedValueOnce(disk("base", "a-new"));
  await store.rename("b.txt", "a.txt", store.capture("device", "workspace", "b.txt"));
  transport.read.mockResolvedValueOnce(disk("base", "b-new", "b.txt"));
  await store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
  firstRead.resolve(disk("base", "b-old", "b.txt"));
  await firstRename;
  expect(draft.revision).toBe("b-new");
  const lastRead = deferred<DiskText>();
  transport.read.mockReturnValueOnce(lastRead.promise);
  const lastRename = store.rename("b.txt", "a.txt", store.capture("device", "workspace", "b.txt"));
  await vi.waitFor(() => expect(transport.read.mock.calls.at(-1)?.[0].path).toBe("a.txt"));
  store.close(draft);
  const replacement = store.open(
    { ...target, deviceName: "Device", workspaceName: "Workspace" },
    disk("replacement", "replacement"),
  );
  lastRead.resolve(disk("base", "old"));
  await lastRename;
  expect(store.snapshot()).toEqual([replacement]);
  expect(replacement.revision).toBe("replacement");
});

test("clean in-flight saves stay clean, and a known failure retains earlier uncertainty", async () => {
  for (const path of ["a.txt", "copy.txt"]) {
    const { store, draft } = await opened();
    const release = deferred<unknown>();
    transport.write.mockReturnValueOnce(release.promise);
    const saving = store.save(draft, { kind: "create", path });
    expect(isDirty(draft)).toBe(false);
    store.close(draft);
    release.resolve({ path, revision: "late", size: 4 });
    await saving;
    expect(store.snapshot()).toEqual([]);
  }
  const { store, draft } = await opened();
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
  await store.save(draft, { kind: "create", path: "copy.txt" });
  const unknown = draft.unknownSave;
  transport.write.mockRejectedValueOnce(new ApiError("conflict", "changed", "failed"));
  await store.save(draft);
  expect(draft.unknownSave).toBe(unknown);
  expect(isDirty(draft)).toBe(true);
});

test("rename completion updates its original drafts without navigating a different view", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " edited" } }).state);
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const renaming = renameFile(store, target, "b.txt");
  const otherView = { pathname: "/devices/other", search: "" };
  vi.stubGlobal("location", otherView);
  transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
  finish(Response.json({ outcome: "succeeded", result: { from: "a.txt", to: "b.txt" } }));
  await renaming;
  await vi.waitFor(() => expect(draft.revision).toBe("b-base"));
  expect(draft.path).toBe("b.txt");
  expect(draft.state!.doc.toString()).toBe("base edited");
  expect(draft.baseText).toBe("base");
  expect(location).toBe(otherView);
});

test("late rename does not migrate a closed draft or a later instance at the same path", async () => {
  const { store, draft } = await opened();
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const renaming = renameFile(store, target, "b.txt");
  store.close(draft);
  transport.read.mockResolvedValueOnce(disk("replacement", "new"));
  const replacement = store.open({ ...target, deviceName: "Device", workspaceName: "Workspace" });
  await vi.waitFor(() => expect(replacement.state).toBeDefined());
  finish(Response.json({ outcome: "succeeded", result: { from: "a.txt", to: "b.txt" } }));
  await renaming;
  expect(store.snapshot()).toEqual([replacement]);
  expect(replacement.path).toBe("a.txt");
  expect(replacement.state!.doc.toString()).toBe("replacement");
});

test("failed rename keeps the original draft path", async () => {
  const { store, draft } = await opened();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ outcome: "failed", error: { code: "conflict", message: "Target exists" } }),
    ),
  );
  await expect(renameFile(store, target, "b.txt")).rejects.toMatchObject({ code: "conflict" });
  expect(draft.path).toBe("a.txt");
});

test("late rename does not capture another draft saved into the old source path", async () => {
  const { store, draft } = await opened();
  transport.read.mockResolvedValueOnce(disk("other", "c-base", "c.txt"));
  const other = store.open({
    ...target,
    path: "c.txt",
    deviceName: "Device",
    workspaceName: "Workspace",
  });
  await vi.waitFor(() => expect(other.state).toBeDefined());
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const renaming = renameFile(store, target, "b.txt");
  transport.write.mockResolvedValueOnce({ path: "a.txt", revision: "new-a", size: 5 });
  expect(await store.save(other, { kind: "create", path: "a.txt" })).toEqual({ kind: "saved" });
  transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
  finish(Response.json({ outcome: "succeeded", result: { from: "a.txt", to: "b.txt" } }));
  await renaming;
  expect(draft.path).toBe("b.txt");
  expect(other.path).toBe("a.txt");
  expect(other.state!.doc.toString()).toBe("other");
});

test.each(["saved", "checked"])(
  "a captured save target cannot become the move source after it is %s",
  async (mode) => {
    const { store, draft } = await opened();
    const other = store.open(
      { ...target, path: "c.txt", deviceName: "Device", workspaceName: "Workspace" },
      disk("other", "c-base", "c.txt"),
    );
    const state = other.state;
    const response = deferred<unknown>();
    transport.write.mockReturnValueOnce(response.promise);
    const saving = store.save(other, { kind: "create", path: "a.txt" });
    const change = store.capture("device", "workspace", "a.txt");
    if (mode === "saved") response.resolve({ path: "a.txt", revision: "new-a", size: 5 });
    else response.resolve(Promise.reject(new ApiError("io_error", "lost", "unknown")));
    await saving;
    if (mode === "checked") {
      transport.read.mockResolvedValueOnce(disk("other", "new-a", "a.txt"));
      await store.check(other);
    }
    transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
    await store.rename("a.txt", "b.txt", change);
    expect(draft.path).toBe("b.txt");
    expect(other.path).toBe("a.txt");
    expect(other.revision).toBe("new-a");
    expect(other.state).toBe(state);
  },
);

test.each(["move", "delete", "check"])(
  "late %s cannot take over the same draft after create-only recreates its source",
  async (kind) => {
    const { store, draft } = await opened();
    const response = deferred<unknown>();
    transport.write.mockReturnValueOnce(response.promise);
    const saving = store.save(draft, { kind: "create", path: "a.txt" });
    const change = store.capture("device", "workspace", "a.txt");
    response.resolve({ path: "a.txt", revision: "recreated", size: 4 });
    expect(await saving).toEqual({ kind: "saved" });
    if (kind === "move") await store.rename("a.txt", "b.txt", change);
    else if (kind === "delete") store.deleted(change);
    else await store.checkMissing("device", "workspace", change);
    expect(draft.path).toBe("a.txt");
    expect(draft.revision).toBe("recreated");
    expect(draft.missing).toBe(false);
  },
);

test("a normal revision save completed before move still follows its source", async () => {
  const { store, draft } = await opened();
  const change = store.capture("device", "workspace", "a.txt");
  transport.write.mockResolvedValueOnce({ path: "a.txt", revision: "saved", size: 4 });
  expect(await store.save(draft)).toEqual({ kind: "saved" });
  transport.read.mockResolvedValueOnce(disk("base", "moved", "b.txt"));
  await store.rename("a.txt", "b.txt", change);
  expect(draft.path).toBe("b.txt");
  expect(draft.revision).toBe("moved");
});

test("moving an unknown save source keeps its original snapshot and the editor", async () => {
  const { store, draft } = await opened();
  const change = store.capture("device", "workspace", "a.txt");
  const state = draft.state!.update({ changes: { from: 0, to: 4, insert: "sent" } }).state;
  store.update(draft, state);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost", "unknown"));
  await store.save(draft);
  transport.read.mockResolvedValueOnce(disk("sent", "moved", "b.txt"));
  await store.rename("a.txt", "b.txt", change);
  expect(draft.path).toBe("b.txt");
  expect(draft.revision).toBe("a-base");
  expect(draft.unknownSave).toMatchObject({ target: { path: "a.txt" }, raw: "sent" });
  expect(draft.baseText).toBe("base");
  expect(draft.diskChanged).toBe(true);
  expect(draft.state).toBe(state);
  transport.read.mockImplementationOnce(async ({ path }) => {
    if (path === "a.txt") throw new ApiError("not_found", "original target moved");
    return disk("sent", "moved", path);
  });
  await store.check(draft);
  expect(draft.error).toMatchObject({ code: "not_found" });
  expect(draft.unknownSave).toBeDefined();
});

test("moving an unknown save-as target neither follows nor probes it", async () => {
  const { store, draft } = await opened();
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost result", "unknown"));
  await store.save(draft, { kind: "create", path: "copy.txt" });
  const unknown = draft.unknownSave;
  transport.read.mockClear();
  await store.rename("copy.txt", "moved.txt", store.capture("device", "workspace", "copy.txt"));
  expect(transport.read).not.toHaveBeenCalled();
  expect(draft.path).toBe("a.txt");
  expect(draft.unknownSave).toBe(unknown);
  expect(draft.unknownSave?.target.path).toBe("copy.txt");
});

test("a late rename interrupts a later save but retains its fixed unknown snapshot", async () => {
  const { store, draft } = await opened();
  const reply = deferred<Response>();
  vi.stubGlobal("fetch", () => reply.promise);
  const renaming = renameFile(store, target, "b.txt");
  transport.write.mockImplementationOnce(
    (_target, _bytes, _revision, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new ApiError("io_error", "save interrupted", "unknown")),
          { once: true },
        );
      }),
  );
  const saving = store.save(draft, { kind: "create", path: "copy.txt" });
  transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
  reply.resolve(Response.json({ outcome: "succeeded", result: { from: "a.txt", to: "b.txt" } }));
  await renaming;
  expect(await saving).toEqual({ kind: "ignored" });
  await vi.waitFor(() => expect(draft.operation).toBeUndefined());
  expect(draft.path).toBe("b.txt");
  expect(draft.unknownSave).toMatchObject({ target: { path: "copy.txt" }, raw: "base" });
  expect(isDirty(draft)).toBe(true);
});

test("a same-path create-only unknown confirmation takes ownership before an old move reply", async () => {
  const { store, draft } = await opened();
  const change = store.capture("device", "workspace", "a.txt");
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost", "unknown"));
  await store.save(draft, { kind: "create", path: "a.txt" });
  transport.read.mockResolvedValueOnce(disk("base", "recreated", "a.txt"));
  await store.check(draft);
  await store.rename("a.txt", "b.txt", change);
  expect(draft.path).toBe("a.txt");
  expect(draft.revision).toBe("recreated");
  expect(draft.missing).toBe(false);
});

test.each(["move", "retry"])(
  "a capacity-rejected opening initializes at its renamed path during %s",
  async (when) => {
    const store = new DraftStore();
    store.observeDevices([{ id: "device", editorBytes: 3 } as Device]);
    const draft = store.open(
      { ...target, deviceName: "Device", workspaceName: "Workspace" },
      disk("base", "old"),
    );
    expect(draft.state).toBeUndefined();
    if (when === "move") store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
    transport.read.mockResolvedValueOnce(disk("base", "moved", "b.txt"));
    await store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
    if (when === "retry") {
      expect(draft.state).toBeUndefined();
      expect(draft.notice).toBe("fileCapacity");
      expect(draft.error).toMatchObject({ code: "limit_exceeded" });
      expect(draft.operation).toBeUndefined();
      store.observeDevices([{ id: "device", editorBytes: 1024 } as Device]);
      transport.read.mockResolvedValueOnce(disk("base", "retry", "b.txt"));
      await store.load(draft);
    }
    expect(draft.path).toBe("b.txt");
    expect(draft.state!.doc.toString()).toBe("base");
    expect(draft.revision).toBe(when === "move" ? "moved" : "retry");
  },
);

test("failed moved-file reads leave a bodyless draft retryable without a checking notice", async () => {
  const store = new DraftStore();
  store.observeDevices([{ id: "device", editorBytes: 3 } as Device]);
  const draft = store.open(
    { ...target, deviceName: "Device", workspaceName: "Workspace" },
    disk("base", "old"),
  );
  expect(draft.state).toBeUndefined();
  expect(draft.notice).toBe("fileCapacity");
  const movedError = new ApiError("io_error", "The moved file could not be read");
  transport.read.mockRejectedValueOnce(movedError);
  await store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
  expect(draft.path).toBe("b.txt");
  expect(draft.state).toBeUndefined();
  expect(draft.operation).toBeUndefined();
  expect(draftProblem(draft)).toBe(movedError);
  expect(draft.notice).toBeUndefined();

  const retryError = new ApiError("io_error", "The retry could not read the file");
  const retryRead = deferred<unknown>();
  transport.read.mockReturnValueOnce(retryRead.promise);
  const retrying = store.load(draft);
  expect(draft.operation?.kind).toBe("loading");
  expect(draftProblem(draft)).toBeUndefined();
  retryRead.resolve(Promise.reject(retryError));
  await retrying;
  expect(draft.state).toBeUndefined();
  expect(draft.operation).toBeUndefined();
  expect(draftProblem(draft)).toBe(retryError);
  expect(draft.notice).toBeUndefined();
});

test("closed drafts stay closed after a late read; lower limits allow shrinking and compliant saves", async () => {
  const { store, draft } = await opened();
  store.observeDevices([{ id: "device", editorBytes: 3 } as Device]);
  expect(store.canSave(draft)).toBe(false);
  expect(store.acceptEdit(draft, 5)).toBe(false);
  expect(draft.notice).toBe("fileCapacity");
  expect(store.acceptEdit(draft, 3)).toBe(true);
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

test("recovering a deleted source preserves its text, foreground error and unknown save snapshot", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " edited" } }).state);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost result", "unknown"));
  await store.save(draft);
  const unknown = draft.unknownSave;
  const error = draft.error;
  store.deleted(store.capture("device", "workspace", "a.txt"));
  expect(draft.unknownSave).toBe(unknown);
  expect(draft.missing).toBe(true);
  expect(draft.baseText).toBe("base");
  expect(draft.state!.doc.toString()).toBe("base edited");
  expect(isDirty(draft)).toBe(true);
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  await store.observe(draft, new AbortController().signal);
  expect(draft.missing).toBe(false);
  expect(draft.notice).toBeUndefined();
  expect(draft.unknownSave).toBe(unknown);
  expect(draft.error).toBe(error);
  expect(draft.state!.doc.toString()).toBe("base edited");
  expect(draft.baseText).toBe("base");
  expect(isDirty(draft)).toBe(true);
});

test.each(["deletedDraft", "missingDraft"] as const)(
  "same-revision recovery clears %s without replacing the editor",
  async (notice) => {
    const { store, draft } = await opened();
    const state = draft.state;
    if (notice === "deletedDraft") store.deleted(store.capture("device", "workspace", "a.txt"));
    else {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            outcome: "failed",
            error: { code: "not_found", message: "File is missing" },
          }),
        ),
      );
      await store.checkMissing(
        "device",
        "workspace",
        store.capture("device", "workspace", "a.txt"),
      );
    }
    expect(draft.notice).toBe(notice);
    expect(draft.missing).toBe(true);
    expect(isDirty(draft)).toBe(true);
    transport.read.mockResolvedValueOnce(disk("base", "a-base"));
    await store.observe(draft, new AbortController().signal);
    expect(draft.notice).toBeUndefined();
    expect(draft.missing).toBe(false);
    expect(draft.state).toBe(state);
    expect(draft.baseText).toBe("base");
    expect(draft.revision).toBe("a-base");
    expect(isDirty(draft)).toBe(false);
  },
);

test("same-revision recovery preserves local editing history, Find and a foreground save error", async () => {
  const { store, draft } = await opened();
  store.update(
    draft,
    draft.state!.update({ effects: StateEffect.appendConfig.of(search()) }).state,
  );
  store.update(
    draft,
    draft.state!.update({
      changes: { from: 4, insert: " edited" },
      selection: { anchor: 2, head: 8 },
      effects: setSearchQuery.of(new SearchQuery({ search: "edited", caseSensitive: true })),
    }).state,
  );
  const error = new ApiError("io_error", "previous save failed");
  transport.write.mockRejectedValueOnce(error);
  expect(await store.save(draft)).toEqual({ kind: "failed", error });
  const state = draft.state;
  store.deleted(store.capture("device", "workspace", "a.txt"));
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  await store.observe(draft, new AbortController().signal);
  expect(draft.notice).toBeUndefined();
  expect(draft.missing).toBe(false);
  expect(draft.state).toBe(state);
  expect(draft.state!.selection.main).toMatchObject({ anchor: 2, head: 8 });
  expect(getSearchQuery(draft.state!)).toMatchObject({ search: "edited", caseSensitive: true });
  expect(draft.error).toBe(error);
  expect(draftProblem(draft)).toBe(error);
  expect(isDirty(draft)).toBe(true);
  expect(undo({ state: draft.state!, dispatch: (tr) => store.update(draft, tr.state) })).toBe(true);
  expect(draft.state!.doc.toString()).toBe("base");
});

test("same-revision observation preserves notices unrelated to a missing source", async () => {
  const { store, draft } = await opened();
  expect(store.acceptEdit(draft, 1025)).toBe(false);
  expect(draft.notice).toBe("fileCapacity");
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  await store.observe(draft, new AbortController().signal);
  expect(draft.notice).toBe("fileCapacity");
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
  await store.rename("a.txt", "b.txt", store.capture("device", "workspace", "a.txt"));
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
    const checking = store.checkMissing(
      "device",
      "workspace",
      store.capture("device", "workspace", "b.txt"),
    );
    transport.write.mockResolvedValueOnce({
      path: "b.txt",
      revision: savedDraft.revision,
      size: savedDraft.bytes,
    });
    expect(await store.save(savedDraft, { kind: "create", path: "b.txt" })).toEqual({
      kind: "saved",
    });
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
  expect(draftProblem(draft)).toMatchObject({ code: "not_found", message: "missing" });
  transport.read.mockResolvedValueOnce(disk("base", "a-base"));
  await store.observe(draft, signal);
  expect(draft.missing).toBe(false);
  expect(draftProblem(draft)).toBeUndefined();
  expect(draft.state).toBe(state);
  let finish!: (value: DiskText) => void;
  transport.read.mockImplementationOnce(
    () =>
      new Promise<DiskText>((resolve) => {
        finish = resolve;
      }),
  );
  const observing = store.observe(draft, signal);
  store.deleted(store.capture("device", "workspace", "a.txt"));
  finish(disk("base", "a-base"));
  await observing;
  expect(draft.missing).toBe(true);
  expect(draft.state).toBe(state);
});

test("clean observations adopt matching disk metadata and preserve numeric selection and Find", async () => {
  const { store, draft } = await opened();
  store.replaceSource(draft, disk("first\nlong second\nthird", "before"));
  store.update(
    draft,
    draft.state!.update({ effects: StateEffect.appendConfig.of(search()) }).state,
  );
  store.update(
    draft,
    draft.state!.update({
      selection: { anchor: 20, head: 9 },
      effects: setSearchQuery.of(new SearchQuery({ search: "second", caseSensitive: true })),
    }).state,
  );
  const position = { line: 2, column: 1, offsetX: -2, offsetY: -3 };
  draft.view.scrollSnapshot = position;
  draft.view.markdownPreview = true;
  draft.view.markdownPosition = { line: 2, offset: -3 };
  draft.error = new ApiError("io_error", "previous save failed");
  const current = disk("FIRST\nx\nend", "after");
  current.meta.bom = true;
  current.raw = "\uFEFFFIRST\nx\nend";
  transport.read.mockResolvedValueOnce(current);
  await store.observe(draft, new AbortController().signal);
  expect(draft.state!.doc.toString()).toBe(current.text);
  expect(draft.baseText).toBe(current.text);
  expect(draft.baseRaw).toBe(current.raw);
  expect(draft.revision).toBe("after");
  expect(draft.format.bom).toBe(true);
  expect(draft.bytes).toBe(Buffer.byteLength(current.raw));
  expect(draft.state!.selection.main).toMatchObject({ anchor: 10, head: 7 });
  expect(getSearchQuery(draft.state!).search).toBe("second");
  expect(getSearchQuery(draft.state!).caseSensitive).toBe(true);
  expect(draft.view.scrollSnapshot).toEqual(position);
  expect(draft.view.markdownPosition).toEqual({ line: 2, offset: -3 });
  expect(draft.error).toMatchObject({ code: "io_error", message: "previous save failed" });
  expect(draft.diskChanged).toBe(false);
  expect(isDirty(draft)).toBe(false);
  store.replaceSource(draft, disk("another source", "replaced"));
  expect(draft.view.scrollSnapshot).toBeUndefined();
  expect(draft.view.markdownPosition).toBeUndefined();
  expect(draft.view.markdownPreview).toBe(true);
});

test.each(["undo", "redo"])(
  "clean synchronization clears old %s and keeps new editing history",
  async (history) => {
    const { store, draft } = await opened();
    const dispatch = (tr: Transaction) => store.update(draft, tr.state);
    store.update(draft, draft.state!.update({ changes: { from: 1, to: 2 } }).state);
    if (history === "redo") expect(undo({ state: draft.state!, dispatch })).toBe(true);
    transport.write.mockResolvedValueOnce({ path: draft.path, revision: "saved" });
    expect(await store.save(draft)).toEqual({ kind: "saved" });
    transport.read.mockResolvedValueOnce(disk("NEW\nFILE", "external"));
    await store.observe(draft, new AbortController().signal);
    expect(undo({ state: draft.state!, dispatch })).toBe(false);
    expect(redo({ state: draft.state!, dispatch })).toBe(false);
    expect(draft.state!.doc.toString()).toBe("NEW\nFILE");
    store.update(draft, draft.state!.update({ changes: { from: 8, insert: " fresh" } }).state);
    expect(undo({ state: draft.state!, dispatch })).toBe(true);
    expect(draft.state!.doc.toString()).toBe("NEW\nFILE");
    expect(redo({ state: draft.state!, dispatch })).toBe(true);
    expect(draft.state!.doc.toString()).toBe("NEW\nFILE fresh");
  },
);

test("an observation that started clean keeps input made before its response arrives", async () => {
  const { store, draft } = await opened();
  expect(isDirty(draft)).toBe(false);
  const pending = deferred<DiskText>();
  transport.read.mockReturnValueOnce(pending.promise);
  const observing = store.observe(draft, new AbortController().signal);
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " local" } }).state);
  pending.resolve(disk("external", "external"));
  await observing;
  expect(draft.state!.doc.toString()).toBe("base local");
  expect(draft.baseText).toBe("base");
  expect(draft.baseRaw).toBe("base");
  expect(draft.revision).toBe("a-base");
  expect(draft.diskChanged).toBe(true);
  expect(isDirty(draft)).toBe(true);
});

test("metadata-only observations preserve editing history", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 1, to: 2 } }).state);
  transport.write.mockResolvedValueOnce({ path: draft.path, revision: "saved" });
  expect(await store.save(draft)).toEqual({ kind: "saved" });
  const current = disk("bse", "new-format");
  current.meta.bom = true;
  current.raw = "\uFEFFbse";
  transport.read.mockResolvedValueOnce(current);
  await store.observe(draft, new AbortController().signal);
  expect(draft.state!.doc.toString()).toBe("bse");
  expect(draft.baseRaw).toBe(current.raw);
  expect(draft.revision).toBe("new-format");
  expect(draft.format.bom).toBe(true);
  expect(draft.bytes).toBe(6);
  const dispatch = (tr: Transaction) => store.update(draft, tr.state);
  expect(undo({ state: draft.state!, dispatch })).toBe(true);
  expect(draft.state!.doc.toString()).toBe("base");
  expect(redo({ state: draft.state!, dispatch })).toBe(true);
  expect(draft.state!.doc.toString()).toBe("bse");
});

test("observations cannot confirm an unknown save or replace a file beyond editing capacity", async () => {
  const { store, draft } = await opened();
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
  expect(await store.save(draft)).toMatchObject({ kind: "failed", error: { outcome: "unknown" } });
  transport.read.mockResolvedValueOnce(disk("base", "published"));
  await store.observe(draft, new AbortController().signal);
  expect(draft.unknownSave).toMatchObject({ target, raw: "base" });
  expect(draft.revision).toBe("a-base");
  expect(isDirty(draft)).toBe(true);
  transport.read.mockResolvedValueOnce(disk("base", "published"));
  await store.check(draft);
  expect(draft.unknownSave).toBeUndefined();
  transport.read.mockResolvedValueOnce(disk("x".repeat(1025), "too-large"));
  await store.observe(draft, new AbortController().signal);
  expect(draft.state!.doc.toString()).toBe("base");
  expect(draft.revision).toBe("published");
  expect(draft.observationError).toMatchObject({ code: "limit_exceeded" });
});
