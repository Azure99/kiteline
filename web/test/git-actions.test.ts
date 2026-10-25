import { expect, test, vi } from "vitest";
import { GitActions } from "../src/git/actions";

test("message subscriptions stay with their repository and do not refresh operation consumers", () => {
  const actions = new GitActions();
  const first = { deviceId: "d", workspaceId: "w", repoId: "one" };
  const second = { ...first, repoId: "two" };
  let activity = 0,
    firstChanges = 0,
    secondChanges = 0;
  actions.subscribe(() => activity++);
  const unsubscribe = actions.subscribeMessage(first, () => firstChanges++);
  actions.subscribeMessage(second, () => secondChanges++);
  actions.message(first, "first message");
  actions.message(second, "second message");
  expect([activity, firstChanges, secondChanges]).toEqual([0, 1, 1]);
  expect(actions.get(first).message).toBe("first message");
  unsubscribe();
  actions.message(first, "retained without a view");
  expect(firstChanges).toBe(1);
  actions.clear();
  expect([activity, firstChanges, secondChanges]).toEqual([1, 1, 2]);
  expect(actions.get(first).message).toBe("");
  expect(actions.get(second).message).toBe("");
});

test("an unconfirmed Git write keeps its request identity, message and diagnostics", async () => {
  vi.stubGlobal("window", new EventTarget());
  let finish!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  try {
    const actions = new GitActions();
    const target = { deviceId: "device", workspaceId: "work", repoId: "repo" };
    actions.message(target, "keep this message");
    const pending = actions.run(target, "git.commit", {
      message: "keep this message",
      indexToken: "index",
    });
    const id = actions.get(target).request!.id;
    actions.dismiss(target);
    expect(actions.get(target).request?.id).toBe(id);
    expect(actions.get(target).lastMethod).toBe("git.commit");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      id,
      method: "git.commit",
      params: { workspaceId: "work", repoId: "repo", message: "keep this message" },
    });
    const error = { code: "io_error", message: "confirmation lost", details: { phase: "commit" } };
    finish(Response.json({ id, outcome: "unknown", error, result: { head: "observed" } }));
    expect(await pending).toBeUndefined();
    expect(actions.get(target)).toMatchObject({
      message: "keep this message",
      request: undefined,
      error: { ...error, outcome: "unknown", result: { head: "observed" } },
      lastMethod: "git.commit",
    });
    actions.dismiss(target);
    expect(actions.get(target)).toMatchObject({
      message: "keep this message",
      error: undefined,
      result: undefined,
      revision: 1,
    });
  } finally {
    fetch.mockRestore();
    vi.unstubAllGlobals();
  }
});

test.each(["failed", "partial"])(
  "%s replies keep their diagnostics without returning a success result to consume selections",
  async (outcome) => {
    vi.stubGlobal("window", new EventTarget());
    const diagnostics = {
      stdout: "first\nsecond",
      stderr: "problem\n",
      changedPaths: outcome === "partial" ? ["file"] : [],
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const { id } = JSON.parse(options!.body as string);
      return Response.json({
        id,
        outcome,
        error: { code: "io_error", message: "problem", details: { phase: "stage" } },
        result: diagnostics,
      });
    });
    try {
      const actions = new GitActions();
      const target = { deviceId: "d", workspaceId: "w", repoId: "repo" };
      const result = await actions.run(target, "git.stage", { paths: ["file"] });
      expect(result).toBeUndefined();
      expect(actions.get(target)).toMatchObject({
        lastMethod: "git.stage",
        completed: undefined,
        error: { outcome, result: diagnostics, details: { phase: "stage" } },
      });
    } finally {
      fetch.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

test("dismissing completed feedback preserves the message, refresh revision and another repository", async () => {
  vi.stubGlobal("window", new EventTarget());
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const { id } = JSON.parse(options!.body as string);
    return Response.json({
      id,
      outcome: "succeeded",
      result: { stdout: "fetched\n", stderr: "", truncated: false },
    });
  });
  try {
    const actions = new GitActions();
    const first = { deviceId: "d", workspaceId: "w", repoId: "one" };
    const second = { ...first, repoId: "two" };
    actions.message(first, "first draft");
    actions.message(second, "second draft");
    await actions.run(first, "git.fetch", {});
    await actions.run(second, "git.fetch", {});
    const revision = actions.get(first).revision;
    actions.dismiss(first);
    expect(actions.get(first)).toMatchObject({
      message: "first draft",
      lastMethod: "git.fetch",
      completed: undefined,
      result: undefined,
      error: undefined,
      revision,
    });
    expect(actions.get(second)).toMatchObject({
      message: "second draft",
      completed: "git.fetch",
      result: { stdout: "fetched\n" },
    });
  } finally {
    fetch.mockRestore();
    vi.unstubAllGlobals();
  }
});

test.each([false, true])(
  "a successful commit clears only the submitted message version (edited: %s)",
  async (edited) => {
    vi.stubGlobal("window", new EventTarget());
    let finish!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    try {
      const actions = new GitActions();
      const first = { deviceId: "d", workspaceId: "w", repoId: "one" };
      const second = { ...first, repoId: "two" };
      actions.message(first, "submitted");
      const pending = actions.run(first, "git.commit", {
        message: "submitted",
        indexToken: "index",
      });
      const id = actions.get(first).request!.id;
      actions.message(second, "another repository");
      if (edited) actions.message(first, "next commit");
      finish(Response.json({ id, outcome: "succeeded", result: { commitOid: "a".repeat(40) } }));
      expect(await pending).toEqual({ commitOid: "a".repeat(40) });
      expect(actions.get(first).message).toBe(edited ? "next commit" : "");
      expect(actions.get(second)).toMatchObject({
        message: "another repository",
        revision: 0,
      });
      expect(actions.get(second).request).toBeUndefined();
      expect(actions.get(second).completed).toBeUndefined();
    } finally {
      fetch.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);
