import { expect, test } from "vitest";
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
