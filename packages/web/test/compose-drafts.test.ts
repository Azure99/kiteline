import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComposeDrafts } from "../src/terminal/compose-drafts";
import { ApiError } from "../src/lib/api";

const target = { deviceId: "device", workspaceId: "workspace", sessionId: "session" };

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function heldResponse() {
  let finish!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  return {
    fetch,
    succeed() {
      const { id } = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
      finish(Response.json({ id, outcome: "succeeded", result: {} }));
    },
  };
}

test("draft text and caret belong to their device and terminal across view changes", () => {
  const drafts = new ComposeDrafts();
  const first = drafts.get(target);
  first.setText("first\n草稿", [6, 8]);
  drafts.get({ ...target, sessionId: "other" }).setText("second");
  drafts.get({ ...target, deviceId: "other" }).setText("third");

  const reopened = drafts.get({ ...target });
  expect(reopened.snapshot().text).toBe("first\n草稿");
  expect(reopened.selection).toEqual([6, 8]);
  expect(drafts.get({ ...target, sessionId: "other" }).snapshot().text).toBe("second");
  expect(drafts.get({ ...target, deviceId: "other" }).snapshot().text).toBe("third");
});

test.each([false, true])(
  "paste with enter=%s sends the original target and clears delivered text",
  async (enter) => {
    const { fetch, succeed } = heldResponse();
    const drafts = new ComposeDrafts();
    const draft = drafts.get(target);
    draft.setText("first\n第二行", [3, 5]);
    const sent = draft.send(enter);

    const url = new URL(String(fetch.mock.calls[0]![0]), "https://kiteline.test");
    expect(url.pathname).toBe("/api/devices/device/rpc");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      method: "sessions.send",
      params: {
        workspaceId: "workspace",
        sessionId: "session",
        input: { type: "paste", text: "first\n第二行", enter },
      },
    });
    succeed();
    expect(await sent).toBe(true);
    expect(draft.snapshot()).toMatchObject({ text: "", sending: false });
    expect(draft.selection).toEqual([0, 0]);
  },
);

test("a pending send survives resubscription, prevents duplicate sends and preserves later edits", async () => {
  const { fetch, succeed } = heldResponse();
  const drafts = new ComposeDrafts();
  const draft = drafts.get(target);
  draft.setText("delivered");
  const firstView = vi.fn();
  const unsubscribe = draft.subscribe(firstView);
  const sent = draft.send(true);
  expect(firstView).toHaveBeenCalled();
  expect(draft.snapshot().sending).toBe(true);
  unsubscribe();

  const reopened = drafts.get(target);
  const nextView = vi.fn();
  reopened.subscribe(nextView);
  expect(reopened.snapshot().sending).toBe(true);
  expect(await reopened.send(true)).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);

  reopened.setText("next input", [4, 4]);
  succeed();
  expect(await sent).toBe(true);
  expect(reopened.snapshot()).toMatchObject({ text: "next input", sending: false });
  expect(reopened.selection).toEqual([4, 4]);
  expect(nextView).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(["failed", "unknown"])(
  "a %s reply retains the draft and diagnostics without replay",
  async (outcome) => {
    const diagnostic = {
      code: "io_error",
      message: "Input was not confirmed",
      details: { pane: "p" },
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const { id } = JSON.parse(options!.body as string);
      return Response.json({ id, outcome, error: diagnostic });
    });
    const drafts = new ComposeDrafts();
    const draft = drafts.get(target);
    draft.setText("keep this\n草稿", [4, 8]);

    expect(await draft.send(true)).toBe(false);
    const reopened = drafts.get(target);
    expect(reopened.snapshot()).toMatchObject({
      text: "keep this\n草稿",
      sending: false,
      error: { ...diagnostic, outcome },
    });
    expect(reopened.snapshot().error).toBeInstanceOf(ApiError);
    expect(reopened.selection).toEqual([4, 8]);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("a lost HTTP response keeps the paste as an unknown result", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Connection lost"));
  const drafts = new ComposeDrafts();
  const draft = drafts.get(target);
  draft.setText("check the program before resending");

  expect(await draft.send(false)).toBe(false);
  expect(drafts.get(target).snapshot()).toMatchObject({
    text: "check the program before resending",
    sending: false,
    error: { code: "io_error", outcome: "unknown", message: "No operation result was received" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("clearing page drafts leaves a late reply attached to the old draft", async () => {
  const { succeed } = heldResponse();
  const drafts = new ComposeDrafts();
  const old = drafts.get(target);
  old.setText("before sign-out");
  const sent = old.send(true);
  drafts.clear();
  const next = drafts.get(target);
  expect(next.snapshot()).toEqual({ text: "", sending: false });
  next.setText("after sign-in", [5, 5]);

  succeed();
  expect(await sent).toBe(true);
  expect(drafts.get(target).snapshot()).toEqual({ text: "after sign-in", sending: false });
  expect(next.selection).toEqual([5, 5]);
});

test("inserting an uploaded path replaces the source selection without changing another draft", () => {
  const drafts = new ComposeDrafts();
  const source = drafts.get(target);
  source.setText("read TARGET next", [5, 11]);
  const other = drafts.get({ ...target, workspaceId: "other", sessionId: "other" });
  other.setText("another draft", [3, 3]);
  const path = "/workspace/project/files/说明's file.txt";

  source.insert(path);
  expect(drafts.get(target).snapshot().text).toBe(`read ${path} next`);
  expect(source.selection).toEqual([5 + path.length, 5 + path.length]);
  expect(other.snapshot().text).toBe("another draft");
  expect(other.selection).toEqual([3, 3]);
});

test("a path inserted while sending remains in the source draft after the reply", async () => {
  const { succeed } = heldResponse();
  const drafts = new ComposeDrafts();
  const source = drafts.get(target);
  source.setText("first request", [13, 13]);
  const sent = source.send(true);

  source.insert("\n/workspace/next.txt");
  expect(source.snapshot().sending).toBe(true);
  succeed();
  expect(await sent).toBe(true);
  expect(drafts.get(target).snapshot()).toMatchObject({
    text: "first request\n/workspace/next.txt",
    sending: false,
  });
});
