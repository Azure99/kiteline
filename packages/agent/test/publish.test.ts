import { expect, test } from "vitest";
import { AppError } from "@kiteline/shared/protocol";
import { publish } from "../src/files/publish.js";

test("cancelled waiters return promptly without letting writes pass the actual owner", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const order: string[] = [];
  const active = new AbortController();
  const owner = publish(async () => {
    entered();
    await gate;
    order.push("owner");
  }, active.signal);
  await ready;
  const cancelled = new AbortController();
  const waiter = publish(async () => {
    order.push("cancelled");
  }, cancelled.signal);
  const next = publish(async () => {
    order.push("next");
  });
  try {
    active.abort(new AppError("cancelled", "Already started"));
    cancelled.abort(new AppError("cancelled", "Still waiting"));
    await expect(waiter).rejects.toMatchObject({ code: "cancelled" });
    expect(order).toEqual([]);
  } finally {
    release();
    await owner;
    await next;
  }
  expect(order).toEqual(["owner", "next"]);
});
