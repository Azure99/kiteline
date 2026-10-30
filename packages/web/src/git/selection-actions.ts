import type { DiscardScope, GitReview } from "@kiteline/shared/protocol";
import type { DraftStore } from "../files/drafts";
import type { GitActions, GitCompletion, GitTarget } from "./actions";
import { confirmDiskVersion } from "./change-actions";
import type { ChangeSelection, ChangeSide } from "./selection";

export function createChangeActions({
  actions,
  target,
  store,
  repoPath,
  selected,
  consume,
}: {
  actions: GitActions;
  target: GitTarget;
  store: DraftStore;
  repoPath: string;
  selected: ChangeSelection[];
  consume: (completed: ChangeSelection[]) => void;
}) {
  function capture(paths: string[], sides: ChangeSide[]) {
    return selected.filter((item) => paths.includes(item.path) && sides.includes(item.side));
  }
  async function consumeAfterSuccess(
    captured: ChangeSelection[],
    pending: Promise<GitCompletion | undefined>,
  ) {
    const completion = await pending;
    if (completion?.outcome === "succeeded") consume(captured);
  }
  return {
    async index(paths: string[], kind: "stage" | "unstage") {
      if (kind === "stage" && !confirmDiskVersion(store, target, repoPath, paths)) return;
      const requestPaths = [...new Set(paths)];
      const sides: ChangeSide[] = kind === "stage" ? ["worktree", "conflict"] : ["staged"];
      const captured = capture(requestPaths, sides);
      await consumeAfterSuccess(
        captured,
        actions.run(target, kind === "stage" ? "git.stage" : "git.unstage", {
          paths: requestPaths,
        }),
      );
    },
    async discard(review: GitReview, scope: DiscardScope) {
      const sides: ChangeSide[] =
        scope === "all" ? ["worktree", "staged", "conflict"] : ["worktree"];
      const captured = capture(review.paths, sides);
      await consumeAfterSuccess(
        captured,
        actions.run(target, "git.discard", {
          paths: review.paths,
          scope,
          reviewToken: review.reviewToken,
        }),
      );
    },
  };
}
