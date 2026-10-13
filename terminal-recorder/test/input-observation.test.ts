import { expect, test } from "vitest";
import { Control } from "../src/control.js";
import { Model } from "../src/model.js";
import { InputQueue } from "../src/input.js";
import type { TerminalFrame } from "@kiteline/shared/protocol/ipc";

test("Web admission, detach, competing conditions and queued expiry share one input sequence", async () => {
  const model = new Model(
    10,
    3,
    100,
    (error) => {
      throw error;
    },
    () => {},
  );
  const control = new Control(
    {
      type: "create",
      sessionId: "admission",
      socket: "/unused",
      workspacePath: "/unused",
      shell: "/bin/bash",
      cols: 10,
      rows: 3,
      historyLines: 100,
    },
    { output: () => {}, resize: () => {}, dead: () => {}, fault: () => {} },
    1000,
  );
  // The existing flow-control pause holds execution while admission remains synchronous.
  control.setPaused(true);
  const errors: TerminalFrame[] = [];
  const queue = new InputQueue(
    control,
    model,
    { terminalInputBytes: 64 },
    (_, frame) => errors.push(frame),
    async () => {},
  );
  const send = (ifInput = model.inputState(), text = "x") =>
    queue.operation({
      type: "session.send",
      input: { type: "text", text },
      ifInput,
      deadline: Date.now() + 40,
    });
  try {
    const initial = await model.observe({}, false);
    queue.input("web", Buffer.from("a"));
    queue.input("web", Buffer.from("b"));
    expect(model.inputState()).toEqual({ epoch: initial.position.epoch, inputSeq: 2 });
    queue.detach("web");
    expect(model.inputState().inputSeq).toBe(2);
    await expect(send(initial.input)).rejects.toMatchObject({ code: "conflict" });
    await expect(send({ ...model.inputState(), epoch: "previous" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(send(model.inputState(), "x".repeat(65))).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    queue.input("web", Buffer.alloc(65));
    expect(errors).toMatchObject([
      { type: "input.error", code: "limit_exceeded", outcome: "failed" },
    ]);
    expect(model.inputState().inputSeq).toBe(2);
    const condition = model.inputState();
    const accepted = send(condition);
    const expires = expect(accepted).rejects.toMatchObject({ code: "timeout", outcome: "failed" });
    await expect(send(condition)).rejects.toMatchObject({ code: "conflict" });
    queue.detach("web");
    expect(await model.observe({ ifChanged: initial.position }, false)).toEqual({
      reason: "unchanged",
      position: initial.position,
      input: { epoch: initial.position.epoch, inputSeq: 3 },
    });
    await expires;
    expect(model.inputState().inputSeq).toBe(3);
    expect(model.position()).toEqual({ epoch: initial.position.epoch, seq: 0 });
    queue.resize("web", 20, 4);
    expect(model.inputState().inputSeq).toBe(3);
  } finally {
    const closing = queue.close();
    control.dispose();
    await closing;
    await model.dispose();
  }
});
