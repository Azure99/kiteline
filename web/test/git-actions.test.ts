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
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      id,
      method: "git.commit",
      params: { workspaceId: "work", repoId: "repo", message: "keep this message" },
    });
    const error = { code: "io_error", message: "confirmation lost", details: { phase: "commit" } };
    finish(Response.json({ id, outcome: "unknown", error, result: { head: "observed" } }));
    await pending;
    expect(actions.get(target)).toMatchObject({
      message: "keep this message",
      request: undefined,
      error: { ...error, outcome: "unknown", result: { head: "observed" } },
    });
  } finally {
    fetch.mockRestore();
    vi.unstubAllGlobals();
  }
});
