import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GitReview, Outcome } from "@kiteline/shared/protocol";
import { DraftStore } from "../src/files/drafts";
import { GitActions } from "../src/git/actions";
import { createChangeActions } from "../src/git/selection-actions";
import { withoutSelection, type ChangeSelection } from "../src/git/selection";

const target = { deviceId: "device", workspaceId: "workspace", repoId: "repo" };
const review: GitReview = {
  paths: ["file", "changed"],
  summary: [],
  reviewToken: "review-token",
};

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  let finish!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const actions = new GitActions();
  const store = new DraftStore();
  let selected: ChangeSelection[] = ["file", "changed", "unrelated"].flatMap((path) =>
    (["staged", "worktree"] as const).map((side) => ({
      path,
      side,
      signature: "original",
    })),
  );
  selected.push({ path: "conflicted", side: "conflict", signature: "original" });
  const consume = vi.fn((completed: ChangeSelection[]) => {
    selected = withoutSelection(selected, completed);
  });
  const changeActions = createChangeActions({
    actions,
    target,
    store,
    repoPath: ".",
    selected,
    consume,
  });
  return {
    actions,
    changeActions,
    consume,
    selected: () => selected,
    changeSignature() {
      selected = selected.map((item) => {
        if (item.path !== "changed") return item;
        return { ...item, signature: "new" };
      });
    },
    request() {
      return JSON.parse(fetch.mock.calls[0]![1]!.body as string) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
    },
    reply(outcome: Outcome) {
      const id = actions.get(target).request!.id;
      finish(
        Response.json({
          id,
          outcome,
          result: { changedPaths: ["file", "changed"] },
          error:
            outcome === "succeeded"
              ? undefined
              : { code: "io_error", message: "Write did not complete" },
        }),
      );
    },
    fetch,
  };
}

test.each(["stage", "unstage"] as const)(
  "%s deduplicates request paths and consumes only the original selection on its sides",
  async (kind) => {
    const state = setup();
    const paths = ["file", "changed"];
    if (kind === "stage") paths.push("conflicted");
    const pending = state.changeActions.index([...paths, "file"], kind);
    expect(state.request()).toMatchObject({
      method: `git.${kind}`,
      params: { workspaceId: target.workspaceId, repoId: target.repoId, paths },
    });
    state.changeSignature();
    state.reply("succeeded");
    await pending;
    expect(state.consume).toHaveBeenCalledOnce();
    const fileSides = state.selected().filter((item) => item.path === "file");
    const conflicts = state.selected().filter((item) => item.path === "conflicted");
    if (kind === "unstage") {
      expect(fileSides.map((item) => item.side)).toEqual(["worktree"]);
      expect(conflicts).toHaveLength(1);
    } else {
      expect(fileSides.map((item) => item.side)).toEqual(["staged"]);
      expect(conflicts).toEqual([]);
    }
    expect(state.selected().filter((item) => item.path === "changed")).toHaveLength(2);
    expect(state.selected().filter((item) => item.path === "unrelated")).toHaveLength(2);
  },
);

test.each(["worktree", "all"] as const)(
  "discard uses the reviewed paths and token, then consumes only its %s scope",
  async (scope) => {
    const state = setup();
    const reviewed = { ...review, paths: [...review.paths] };
    if (scope === "all") reviewed.paths.push("conflicted");
    const pending = state.changeActions.discard(reviewed, scope);
    expect(state.request()).toMatchObject({
      method: "git.discard",
      params: {
        workspaceId: target.workspaceId,
        repoId: target.repoId,
        paths: reviewed.paths,
        scope,
        reviewToken: reviewed.reviewToken,
      },
    });
    state.changeSignature();
    state.reply("succeeded");
    await pending;
    const remainingFileSides = state.selected().filter((item) => item.path === "file");
    const conflicts = state.selected().filter((item) => item.path === "conflicted");
    if (scope === "all") {
      expect(remainingFileSides).toEqual([]);
      expect(conflicts).toEqual([]);
    } else {
      expect(remainingFileSides.map((item) => item.side)).toEqual(["staged"]);
      expect(conflicts).toHaveLength(1);
    }
    expect(state.selected().filter((item) => item.path === "changed")).toHaveLength(2);
    expect(state.selected().filter((item) => item.path === "unrelated")).toHaveLength(2);
  },
);

test.each(["failed", "partial", "unknown"] as const)(
  "a %s discard result does not consume selection",
  async (outcome) => {
    const state = setup();
    const original = state.selected();
    const pending = state.changeActions.discard(review, "all");
    state.reply(outcome);
    await pending;
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.selected()).toBe(original);
  },
);

test("a busy action that never starts does not consume selection", async () => {
  const state = setup();
  const original = state.selected();
  const pending = state.actions.run(target, "git.stage", { paths: ["other"] });
  await state.changeActions.index(["file"], "unstage");
  expect(state.fetch).toHaveBeenCalledOnce();
  expect(state.consume).not.toHaveBeenCalled();
  state.reply("succeeded");
  await pending;
  expect(state.selected()).toBe(original);
});
