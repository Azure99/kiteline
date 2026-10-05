import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import type { Device } from "@kiteline/shared/protocol";
import { DraftStore, draftError, isDirty } from "../src/files/drafts";
import { ApiError } from "../src/lib/api";
import type { DiskText, FileTarget } from "../src/files/content";
import { LanguageDescription, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { closeDraft } from "../src/files/navigation";

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
  store.limits([{ id: "device", editorBytes: 1024 } as Device]);
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

test("preloaded open adopts once and never replaces an existing editor or its undo state", () => {
  const store = new DraftStore();
  store.limits([{ id: "device", editorBytes: 1024 } as Device]);
  const named = { ...target, deviceName: "Device", workspaceName: "Workspace" };
  const draft = store.open(named, disk("base", "first"));
  const edited = draft.state!.update({ changes: { from: 4, insert: " edited" } }).state;
  store.update(draft, edited);
  expect(store.open(named, disk("late disk", "second"))).toBe(draft);
  expect(draft.state).toBe(edited);
  expect(draft.revision).toBe("first");
  expect(transport.read).not.toHaveBeenCalled();
});

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
  store.adopt(duplicate, disk("other", "moved", "a.txt"));
  const browser = Object.assign(new EventTarget(), {
    location: new URL(
      "https://kiteline.test/devices/device/workspaces/workspace/git?file=a.txt&repo=r",
    ),
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("PopStateEvent", Event);
  vi.stubGlobal("history", {
    replaceState: (_state: unknown, _title: string, path: string) => {
      browser.location = new URL(path, browser.location);
    },
  });
  closeDraft(store, duplicate);
  expect(browser.location.searchParams.get("file")).toBe("a.txt");
  expect(store.find(target)).toBe(draft);
  closeDraft(store, draft);
  expect(browser.location.searchParams.has("file")).toBe(false);
  expect(browser.location.pathname.endsWith("/git")).toBe(true);
  expect(browser.location.searchParams.get("repo")).toBe("r");
});

test("saving adopts the returned logical target while preserving later typing and undo", async () => {
  const { store, draft } = await opened();
  const pending = deferred<{ path: string; size: number; revision: string }>();
  transport.write.mockReturnValueOnce(pending.promise);
  const saving = store.save(draft, "PARENT/copy.txt");
  const edited = draft.state!.update({ changes: { from: 4, insert: " later" } }).state;
  store.update(draft, edited);
  pending.resolve({ path: "Parent/copy.txt", size: 4, revision: "copy" });
  expect(await saving).toBe(true);
  expect(draft.path).toBe("Parent/copy.txt");
  expect(draft.state).toBe(edited);
  expect(draft.baseText).toBe("base");
  expect(isDirty(draft)).toBe(true);
});

test("reloading a draft retains its loaded language support", async () => {
  const { store, draft } = await opened();
  const support = await LanguageDescription.matchFilename(languages, "a.js")!.load();
  store.update(draft, draft.state!.update({ effects: draft.language.reconfigure(support) }).state);
  store.adopt(draft, disk("const count = 2;", "reloaded", "a.js"));
  expect(draft.state!.doc.toString()).toBe("const count = 2;");
  expect(syntaxTree(draft.state!).topNode.name).toBe("Script");
  expect(syntaxTree(draft.state!).toString()).toContain("VariableDeclaration");
});

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
  transport.read.mockImplementationOnce(async ({ path }) =>
    path === "copy.txt" ? disk("base later", "copy", path) : disk("base", "original", path),
  );
  await store.check(draft);
  expect(draft.path).toBe("copy.txt");
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
    const root = await mkdtemp("/var/tmp/kiteline-draft-save-");
    const store = new DraftStore();
    store.limits([{ id: "device", editorBytes: 1024 } as Device]);
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
      const saving = store.save(draft, "requested" in paths ? paths.requested : paths.saved, null);
      await published.promise;
      store.update(
        draft,
        draft.state!.update({
          changes: { from: 4, insert: " later" },
          selection: { anchor: 5, head: 10 },
          annotations: isolateHistory.of("full"),
        }).state,
      );
      const state = draft.state;
      draft.scrollTop = 120;
      vi.stubGlobal("fetch", async () => {
        await rename(join(root, paths.from), join(root, paths.to));
        return Response.json({ outcome: "succeeded", result: { from: paths.from, to: paths.to } });
      });
      await expect(
        store.renameFile({ ...target, path: paths.from }, paths.to),
      ).rejects.toMatchObject({ code: "busy" });
      expect(store.savingWithin("device", "workspace", paths.from)).toBe(true);
      expect(store.savingWithin("other", "workspace", paths.from)).toBe(false);
      release.resolve();
      expect(await saving).toBe(true);
      await store.renameFile({ ...target, path: paths.from }, paths.to);
      await vi.waitFor(() => expect(draft.operation).toBeUndefined());
      expect(draft.path).toBe(paths.final);
      expect(draft.baseRaw).toBe("sent");
      expect(draft.revision).toBe((await read({ ...target, path: paths.final })).meta.revision);
      expect(draft.state).toBe(state);
      expect(draft.scrollTop).toBe(120);
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

test("late channel failures cannot contaminate a moved-source observation", async () => {
  const { store, draft } = await opened();
  const first = deferred<DiskText>();
  const entered = deferred<void>();
  transport.read.mockImplementationOnce((_target, _signal, onChannel) => {
    onChannel("old-read");
    entered.resolve();
    return first.promise;
  });
  const checking = store.check(draft);
  await entered.promise;
  const second = deferred<DiskText>();
  transport.read.mockReturnValueOnce(second.promise);
  const moving = store.rename("device", "workspace", "a.txt", "b.txt");
  store.fileFailed("old-read", { code: "cancelled", message: "Old read cancelled" });
  expect(draft.error).toBeUndefined();
  first.resolve(disk("external", "a-old"));
  await checking;
  second.resolve(disk("base", "b-base", "b.txt"));
  await moving;
  expect(draft.revision).toBe("b-base");
  expect(draft.error).toBeUndefined();
});

test("stale moved-source reads cannot survive rename round trips or a closed draft", async () => {
  const { store, draft } = await opened();
  const firstRead = deferred<DiskText>();
  transport.read.mockReturnValueOnce(firstRead.promise);
  const firstRename = store.rename("device", "workspace", "a.txt", "b.txt");
  await vi.waitFor(() => expect(transport.read.mock.calls.at(-1)?.[0].path).toBe("b.txt"));
  transport.read.mockResolvedValueOnce(disk("base", "a-new"));
  await store.rename("device", "workspace", "b.txt", "a.txt");
  transport.read.mockResolvedValueOnce(disk("base", "b-new", "b.txt"));
  await store.rename("device", "workspace", "a.txt", "b.txt");
  firstRead.resolve(disk("base", "b-old", "b.txt"));
  await firstRename;
  expect(draft.revision).toBe("b-new");
  const lastRead = deferred<DiskText>();
  transport.read.mockReturnValueOnce(lastRead.promise);
  const lastRename = store.rename("device", "workspace", "b.txt", "a.txt");
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
    const saving = store.save(draft, path);
    expect(isDirty(draft)).toBe(false);
    store.close(draft);
    release.resolve({ path, revision: "late", size: 4 });
    await saving;
    expect(store.snapshot()).toEqual([]);
  }
  const { store, draft } = await opened();
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost response", "unknown"));
  await store.save(draft, "copy.txt");
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
  const renaming = store.renameFile(target, "b.txt");
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
  const renaming = store.renameFile(target, "b.txt");
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
  await expect(store.renameFile(target, "b.txt")).rejects.toMatchObject({ code: "conflict" });
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
  const renaming = store.renameFile(target, "b.txt");
  transport.write.mockResolvedValueOnce({ path: "a.txt", revision: "new-a", size: 5 });
  expect(await store.save(other, "a.txt", null)).toBe(true);
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
    const saving = store.save(other, "a.txt", null);
    const change = store.capture("device", "workspace", "a.txt");
    if (mode === "saved") response.resolve({ path: "a.txt", revision: "new-a", size: 5 });
    else response.resolve(Promise.reject(new ApiError("io_error", "lost", "unknown")));
    await saving;
    if (mode === "checked") {
      transport.read.mockResolvedValueOnce(disk("other", "new-a", "a.txt"));
      await store.check(other);
    }
    transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
    await store.rename("device", "workspace", "a.txt", "b.txt", change);
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
    const saving = store.save(draft, "a.txt", null);
    const change = store.capture("device", "workspace", "a.txt");
    response.resolve({ path: "a.txt", revision: "recreated", size: 4 });
    expect(await saving).toBe(true);
    if (kind === "move") await store.rename("device", "workspace", "a.txt", "b.txt", change);
    else if (kind === "delete")
      store.deleted("device", "workspace", "a.txt", "deletedDraft", change);
    else await store.checkMissing("device", "workspace", "a.txt", change);
    expect(draft.path).toBe("a.txt");
    expect(draft.revision).toBe("recreated");
    expect(draft.missing).toBe(false);
  },
);

test("a normal revision save completed before move still follows its source", async () => {
  const { store, draft } = await opened();
  const change = store.capture("device", "workspace", "a.txt");
  transport.write.mockResolvedValueOnce({ path: "a.txt", revision: "saved", size: 4 });
  expect(await store.save(draft)).toBe(true);
  transport.read.mockResolvedValueOnce(disk("base", "moved", "b.txt"));
  await store.rename("device", "workspace", "a.txt", "b.txt", change);
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
  await store.rename("device", "workspace", "a.txt", "b.txt", change);
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
  await store.save(draft, "copy.txt", null);
  const unknown = draft.unknownSave;
  transport.read.mockClear();
  await store.rename("device", "workspace", "copy.txt", "moved.txt");
  expect(transport.read).not.toHaveBeenCalled();
  expect(draft.path).toBe("a.txt");
  expect(draft.unknownSave).toBe(unknown);
  expect(draft.unknownSave?.target.path).toBe("copy.txt");
});

test("a late rename interrupts a later save but retains its fixed unknown snapshot", async () => {
  const { store, draft } = await opened();
  const reply = deferred<Response>();
  vi.stubGlobal("fetch", () => reply.promise);
  const renaming = store.renameFile(target, "b.txt");
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
  const saving = store.save(draft, "copy.txt", null);
  transport.read.mockResolvedValueOnce(disk("base", "b-base", "b.txt"));
  reply.resolve(Response.json({ outcome: "succeeded", result: { from: "a.txt", to: "b.txt" } }));
  await renaming;
  expect(await saving).toBe(false);
  await vi.waitFor(() => expect(draft.operation).toBeUndefined());
  expect(draft.path).toBe("b.txt");
  expect(draft.unknownSave).toMatchObject({ target: { path: "copy.txt" }, raw: "base" });
  expect(isDirty(draft)).toBe(true);
});

test("a same-path create-only unknown confirmation takes ownership before an old move reply", async () => {
  const { store, draft } = await opened();
  const change = store.capture("device", "workspace", "a.txt");
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost", "unknown"));
  await store.save(draft, "a.txt", null);
  transport.read.mockResolvedValueOnce(disk("base", "recreated", "a.txt"));
  await store.check(draft);
  await store.rename("device", "workspace", "a.txt", "b.txt", change);
  expect(draft.path).toBe("a.txt");
  expect(draft.revision).toBe("recreated");
  expect(draft.missing).toBe(false);
});

test.each(["move", "retry"])(
  "a capacity-rejected opening initializes at its renamed path during %s",
  async (when) => {
    const store = new DraftStore();
    store.limits([{ id: "device", editorBytes: 3 } as Device]);
    const draft = store.open(
      { ...target, deviceName: "Device", workspaceName: "Workspace" },
      disk("base", "old"),
    );
    expect(draft.state).toBeUndefined();
    if (when === "move") store.limits([{ id: "device", editorBytes: 1024 } as Device]);
    transport.read.mockResolvedValueOnce(disk("base", "moved", "b.txt"));
    await store.rename("device", "workspace", "a.txt", "b.txt");
    if (when === "retry") {
      expect(draft.state).toBeUndefined();
      expect(draft.notice).toBe("fileCapacity");
      store.limits([{ id: "device", editorBytes: 1024 } as Device]);
      transport.read.mockResolvedValueOnce(disk("base", "retry", "b.txt"));
      await store.load(draft);
    }
    expect(draft.path).toBe("b.txt");
    expect(draft.state!.doc.toString()).toBe("base");
    expect(draft.revision).toBe(when === "move" ? "moved" : "retry");
  },
);

test("closed drafts stay closed after a late read; lower limits allow shrinking and compliant saves", async () => {
  const { store, draft } = await opened();
  store.limits([{ id: "device", editorBytes: 3 } as Device]);
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

test("deleting an open file preserves its text and unknown save snapshot", async () => {
  const { store, draft } = await opened();
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " edited" } }).state);
  transport.write.mockRejectedValueOnce(new ApiError("io_error", "lost result", "unknown"));
  await store.save(draft);
  const unknown = draft.unknownSave;
  store.deleted("device", "workspace", "a.txt");
  expect(draft.unknownSave).toBe(unknown);
  expect(draft.missing).toBe(true);
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
  expect(draftError(draft)).toContain("missing");
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
