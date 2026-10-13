import { expect, test } from "vitest";
import { terminalRpc } from "../src/terminal/rpc.js";
import type { Sessions } from "../src/terminal/sessions.js";

const sessions = {
  get: () => ({ session: { webStatus: "available", historyGap: true } }),
  recorder: { request: async (request: unknown) => request },
} as unknown as Sessions;
const target = { sessionId: "session", workspaceId: "workspace" };

test("snapshot conditions require output position and explicit observation options", async () => {
  for (const ifChanged of [
    { epoch: "epoch", seq: 0 },
    { epoch: "epoch", seq: 0, attrs: false },
    { epoch: "epoch", seq: 0, tail: null },
  ])
    expect(() => terminalRpc("sessions.snapshot", { ...target, ifChanged }, sessions)).toThrow();
  for (const tail of [null, 0]) {
    const ifChanged = { epoch: "epoch", seq: 0, tail, attrs: false };
    expect(
      await terminalRpc("sessions.snapshot", { ...target, ifChanged }, sessions),
    ).toMatchObject({
      type: "snapshot",
      options: { ifChanged },
      historyGap: true,
    });
  }
});

test("send accepts literal text with Enter and input conditions but rejects raw and unsupported keys", async () => {
  const started = Date.now();
  const result = await terminalRpc(
    "sessions.send",
    {
      ...target,
      input: { type: "text", text: "Enter", enter: true },
      ifInput: { epoch: "epoch", inputSeq: 2 },
    },
    sessions,
  );
  expect(result).toMatchObject({
    type: "session.send",
    input: { type: "text", text: "Enter", enter: true },
    ifInput: { epoch: "epoch", inputSeq: 2 },
    deadline: expect.any(Number),
  });
  expect((result as { deadline: number }).deadline).toBeGreaterThanOrEqual(started + 5000);
  for (const input of [
    { type: "raw", text: "x" },
    { type: "key", key: "Home" },
    { type: "text", text: 1 },
    { type: "paste", text: "x", enter: "yes" },
  ])
    expect(() => terminalRpc("sessions.send", { ...target, input }, sessions)).toThrow();
});

test("wait defaults are finite, shorter timeout is valid, and change needs an output position", async () => {
  const started = Date.now();
  const result = await terminalRpc("sessions.wait", target, sessions);
  expect(result).toMatchObject({
    type: "wait",
    options: { mode: "quiet", quietMs: 300 },
    historyGap: true,
  });
  expect((result as { deadline: number }).deadline).toBeGreaterThanOrEqual(started + 1000);
  expect(
    await terminalRpc("sessions.wait", { ...target, mode: "quiet", timeoutMs: 50 }, sessions),
  ).toMatchObject({ options: { quietMs: 300 } });
  expect(
    await terminalRpc(
      "sessions.wait",
      { ...target, mode: "change", after: { epoch: "epoch", seq: 1 } },
      sessions,
    ),
  ).toMatchObject({ options: { mode: "change", after: { epoch: "epoch", seq: 1 } } });
  for (const params of [{ mode: "match", text: "READY" }, { mode: "change" }])
    expect(() => terminalRpc("sessions.wait", { ...target, ...params }, sessions)).toThrow();
});

test("operation deadlines and resize dimensions are validated at the RPC boundary", async () => {
  for (const timeoutMs of [0, 10001, 1.5])
    for (const method of ["sessions.send", "sessions.resize", "sessions.wait"])
      expect(() =>
        terminalRpc(
          method,
          {
            ...target,
            input: { type: "text", text: "x" },
            cols: 80,
            rows: 24,
            timeoutMs,
          },
          sessions,
        ),
      ).toThrow();
  const started = Date.now();
  const result = await terminalRpc(
    "sessions.resize",
    { ...target, cols: 80, rows: 24, timeoutMs: 10 },
    sessions,
  );
  expect(result).toMatchObject({ type: "session.resize", cols: 80, rows: 24 });
  expect((result as { deadline: number }).deadline).toBeGreaterThanOrEqual(started + 10);
  for (const cols of [0, 1.5])
    expect(() => terminalRpc("sessions.resize", { ...target, cols, rows: 24 }, sessions)).toThrow();
});

test("unavailable recording rejects terminal observation and input until explicit recovery", () => {
  const unavailable = {
    ...sessions,
    get: () => ({ session: { webStatus: "unavailable", historyGap: true } }),
  } as unknown as Sessions;
  for (const method of ["sessions.snapshot", "sessions.send", "sessions.wait", "sessions.resize"])
    expect(() => terminalRpc(method, target, unavailable)).toThrowError(
      "Recover terminal recording first",
    );
});
