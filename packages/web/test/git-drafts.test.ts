import { expect, test } from "vitest";
import type { Device } from "@kiteline/shared/protocol";
import { DraftStore, type Draft } from "../src/files/drafts";
import { hasUnsavedDraft } from "../src/git/drafts";

const target = { deviceId: "device", workspaceId: "workspace" };

function opened(store: DraftStore, path: string, scope = target) {
  return store.open(
    { ...scope, path, deviceName: scope.deviceId, workspaceName: scope.workspaceId },
    {
      target: { ...scope, path },
      text: "disk",
      raw: "disk",
      meta: {
        size: 4,
        contentType: "text/plain",
        filename: path,
        revision: "disk-version",
        bom: false,
        lineEnding: "lf",
      },
    },
  );
}

function edit(store: DraftStore, draft: Draft) {
  store.update(draft, draft.state!.update({ changes: { from: 4, insert: " draft" } }).state);
}

test("Git draft markers only use unsaved content from the matching device and workspace", () => {
  const store = new DraftStore();
  store.limits(["device", "other-device"].map((id) => ({ id, editorBytes: 1024 }) as Device));
  const current = opened(store, "src/a.ts");
  edit(store, opened(store, "src/a.ts", { ...target, deviceId: "other-device" }));
  edit(store, opened(store, "src/a.ts", { ...target, workspaceId: "other-workspace" }));
  expect(hasUnsavedDraft(store.snapshot(), target, ".", ["src/a.ts"])).toBe(false);
  edit(store, current);
  expect(hasUnsavedDraft(store.snapshot(), target, ".", ["src/a.ts"])).toBe(true);
  expect(hasUnsavedDraft(store.snapshot(), target, ".", ["src/b.ts"])).toBe(false);
});

test("nested repositories match the exact workspace path rather than a directory prefix", () => {
  const store = new DraftStore();
  store.limits([{ id: "device", editorBytes: 1024 } as Device]);
  edit(store, opened(store, "services/api/src/a.ts"));
  expect(hasUnsavedDraft(store.snapshot(), target, "services/api", ["src/a.ts"])).toBe(true);
  expect(hasUnsavedDraft(store.snapshot(), target, ".", ["src/a.ts"])).toBe(false);
  expect(hasUnsavedDraft(store.snapshot(), target, "services", ["src/a.ts"])).toBe(false);
  expect(hasUnsavedDraft(store.snapshot(), target, "services/api", ["src"])).toBe(false);
  expect(hasUnsavedDraft(store.snapshot(), target, "services/api-other", ["src/a.ts"])).toBe(false);
});
