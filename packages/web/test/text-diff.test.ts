import { expect, test } from "vitest";
import { diffText } from "../src/files/text-diff";

test("equal text needs no worker", async () => {
  expect(await diffText("same text", "same text", new AbortController().signal)).toEqual([]);
});

test("an already cancelled comparison stops before creating a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(diffText("before", "after", controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});
