import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitActions } from "../src/git/actions";

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  let finish!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
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
  expect(actions.get(target).request?.method).toBe("git.commit");
  expect(await actions.run(target, "git.stage", { paths: ["other"] })).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
    id,
    method: "git.commit",
    params: { workspaceId: "work", repoId: "repo", message: "keep this message" },
  });
  const error = { code: "io_error", message: "confirmation lost", details: { phase: "commit" } };
  finish(Response.json({ id, outcome: "unknown", error, result: { head: "observed" } }));
  const completion = await pending;
  expect(completion).toMatchObject({
    method: "git.commit",
    outcome: "unknown",
    error: { ...error, outcome: "unknown", result: { head: "observed" } },
  });
  expect(actions.get(target)).toMatchObject({
    message: "keep this message",
    request: undefined,
    completion,
  });
  actions.dismiss(target);
  expect(actions.get(target)).toMatchObject({
    message: "keep this message",
    completion: undefined,
    revision: 1,
  });
});

test.each(["failed", "partial"])(
  "%s replies return their own outcome and retain the original diagnostics",
  async (outcome) => {
    const diagnostics = {
      stdout: "first\nsecond",
      stderr: "problem\n",
      changedPaths: outcome === "partial" ? ["file"] : [],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const { id } = JSON.parse(options!.body as string);
      return Response.json({
        id,
        outcome,
        error: { code: "io_error", message: "problem", details: { phase: "stage" } },
        result: diagnostics,
      });
    });
    const actions = new GitActions();
    const target = { deviceId: "d", workspaceId: "w", repoId: "repo" };
    const completion = await actions.run(target, "git.stage", { paths: ["file"] });
    expect(completion).toMatchObject({
      method: "git.stage",
      outcome,
      error: { outcome, result: diagnostics, details: { phase: "stage" } },
    });
    expect(actions.get(target)).toMatchObject({
      request: undefined,
      completion,
      revision: 1,
    });
  },
);

test("an HTTP error returns this write's error without inventing an outcome", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: { code: "invalid_argument", message: "Invalid branch name" } },
      { status: 400 },
    ),
  );
  const actions = new GitActions();
  const target = { deviceId: "d", workspaceId: "w", repoId: "repo" };
  const completion = await actions.run(target, "git.branch.create", {
    name: "bad",
    switch: true,
  });
  expect(completion).toMatchObject({
    method: "git.branch.create",
    outcome: undefined,
    error: { code: "invalid_argument", message: "Invalid branch name", outcome: undefined },
  });
  expect(actions.get(target)).toMatchObject({ request: undefined, completion, revision: 1 });
});

test.each(["succeeded", "failed"] as const)(
  "a failed cancellation can be retried while the original write finishes as %s",
  async (outcome) => {
    let finish!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: "io_error", message: "Cancellation failed" } },
        { status: 500 },
      ),
    );
    fetch.mockResolvedValueOnce(Response.json({ found: true }));
    const actions = new GitActions();
    const target = { deviceId: "d", workspaceId: "w", repoId: "repo" };
    const pending = actions.run(target, "git.stage", { paths: ["file"] });
    const id = actions.get(target).request!.id;
    await actions.cancel(target);
    expect(actions.get(target)).toMatchObject({
      request: {
        id,
        cancelling: false,
        cancelError: { message: "Cancellation failed", outcome: undefined },
      },
      completion: undefined,
      revision: 0,
    });
    const retry = actions.cancel(target);
    expect(actions.get(target).request?.cancelError).toBeUndefined();
    await retry;
    expect(fetch.mock.calls[2]![1]?.method).toBe("DELETE");
    expect(actions.get(target).request).toMatchObject({ id, cancelling: true });
    const error = { code: "io_error", message: "Final write failure" };
    finish(Response.json({ id, outcome, result: { changedPaths: ["file"] }, error }));
    const completion = await pending;
    expect(completion?.outcome).toBe(outcome);
    expect(actions.get(target)).toMatchObject({ request: undefined, completion, revision: 1 });
    if (completion?.outcome === "succeeded") {
      expect(completion.result).toEqual({ changedPaths: ["file"] });
      expect(completion.error).toBeUndefined();
    } else {
      expect(completion?.error).toMatchObject({ message: "Final write failure", outcome });
    }
  },
);

test.each([false, true])(
  "a late cancellation error cannot change the completed or next write (next started: %s)",
  async (startNext) => {
    let finish!: (response: Response) => void;
    let finishCancel!: (response: Response) => void;
    let finishNext!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNext = resolve;
        }),
      );
    const actions = new GitActions();
    const target = { deviceId: "d", workspaceId: "w", repoId: "repo" };
    const pending = actions.run(target, "git.stage", { paths: ["first"] });
    const id = actions.get(target).request!.id;
    const cancelling = actions.cancel(target);
    finish(Response.json({ id, outcome: "succeeded", result: { changedPaths: ["first"] } }));
    const completed = await pending;
    let next: ReturnType<typeof actions.run> | undefined;
    if (startNext) next = actions.run(target, "git.stage", { paths: ["second"] });
    finishCancel(
      Response.json({ error: { code: "io_error", message: "Late cancellation" } }, { status: 500 }),
    );
    await cancelling;
    if (next) {
      const request = actions.get(target).request!;
      expect(request).toMatchObject({ cancelling: false });
      expect(request.id).not.toBe(id);
      expect(request.cancelError).toBeUndefined();
      expect(actions.get(target).completion).toBeUndefined();
      finishNext(
        Response.json({
          id: request.id,
          outcome: "succeeded",
          result: { changedPaths: ["second"] },
        }),
      );
      expect((await next)?.outcome).toBe("succeeded");
    } else {
      expect(actions.get(target)).toMatchObject({ request: undefined, completion: completed });
    }
  },
);

test("dismissing completed feedback preserves the message, refresh revision and another repository", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const { id } = JSON.parse(options!.body as string);
    return Response.json({
      id,
      outcome: "succeeded",
      result: { stdout: "fetched\n", stderr: "", truncated: false },
    });
  });
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
    completion: undefined,
    revision,
  });
  expect(actions.get(second)).toMatchObject({
    message: "second draft",
    completion: {
      method: "git.fetch",
      outcome: "succeeded",
      result: { stdout: "fetched\n" },
    },
  });
});

test.each([false, true])(
  "a successful commit clears only the submitted message version (edited: %s)",
  async (edited) => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
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
    expect(await pending).toEqual({
      method: "git.commit",
      outcome: "succeeded",
      result: { commitOid: "a".repeat(40) },
    });
    expect(actions.get(first).message).toBe(edited ? "next commit" : "");
    expect(actions.get(second)).toMatchObject({
      message: "another repository",
      revision: 0,
    });
    expect(actions.get(second).request).toBeUndefined();
    expect(actions.get(second).completion).toBeUndefined();
  },
);
