import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { Model } from "../src/model.js";

const model = (cols = 10, rows = 3) =>
  new Model(
    cols,
    rows,
    100,
    (error) => {
      throw error;
    },
    () => {},
  );

test("snapshots preserve queue order, pending wrap and partially parsed control sequences", async () => {
  const terminal = model();
  try {
    terminal.output(Buffer.from("1234567890"));
    const first = terminal.observe({}, false);
    terminal.resize(12, 4);
    terminal.output(Buffer.from("\r\n界🙂é\x1b[3"));
    const second = terminal.observe({}, true);
    expect(await first).toMatchObject({
      cols: 10,
      rows: 3,
      cursor: { x: 10, y: 0, visible: true },
      screen: [{ text: "1234567890", wrapped: false }, {}, {}],
      position: { seq: 1 },
    });
    expect(await second).toMatchObject({
      cols: 12,
      rows: 4,
      historyGap: true,
      position: { seq: 3 },
      screen: [{}, { text: "界🙂é", wrapped: false }, {}, {}],
    });
    terminal.output(Buffer.from("1mX"));
    expect(await terminal.observe({ attrs: true }, false)).toMatchObject({
      screen: [{}, { text: "界🙂éX", attrs: [{ start: 5, end: 6, fg: { palette: 1 } }] }, {}, {}],
    });
  } finally {
    await terminal.dispose();
  }
});

test("conditional snapshots bind options and return current input without an output change", async () => {
  const terminal = model();
  try {
    const initial = await terminal.observe({}, false);
    expect(initial).toMatchObject({
      reason: "full",
      position: { seq: 0, tail: null, attrs: false },
      input: { epoch: initial.position.epoch, inputSeq: 0 },
    });
    terminal.admitInput();
    expect(await terminal.observe({ ifChanged: initial.position }, false)).toEqual({
      reason: "unchanged",
      position: initial.position,
      input: { epoch: initial.position.epoch, inputSeq: 1 },
    });
    expect(await terminal.observe({ tail: 0, ifChanged: initial.position }, false)).toMatchObject({
      reason: "full",
      position: { tail: 0 },
      tail: { lines: [] },
    });
    expect(
      await terminal.observe({ attrs: true, ifChanged: initial.position }, false),
    ).toMatchObject({ reason: "full", position: { attrs: true }, screen: [{ attrs: [] }, {}, {}] });
    expect(
      await terminal.observe({ ifChanged: { ...initial.position, epoch: "previous" } }, false),
    ).toMatchObject({ reason: "reset", screen: [{ text: "" }, {}, {}] });
    terminal.output(Buffer.from("\x1b[H"));
    expect(await terminal.observe({ ifChanged: initial.position }, false)).toMatchObject({
      reason: "full",
      position: { seq: 1 },
      screen: [{ text: "" }, {}, {}],
    });
  } finally {
    await terminal.dispose();
  }
});

test("attribute-only repaint changes position and reports named non-default cell spans", async () => {
  const terminal = model();
  try {
    terminal.output(Buffer.from("界🙂é"));
    const first = await terminal.observe({ attrs: true }, false);
    terminal.output(Buffer.from("\r\x1b[7;1;38;2;1;2;3;48;5;4m界🙂\x1b[0mé"));
    const second = await terminal.observe({ attrs: true, ifChanged: first.position }, false);
    expect(second).toMatchObject({
      reason: "full",
      position: { seq: first.position.seq + 1 },
      screen: [
        {
          text: "界🙂é",
          attrs: [
            {
              start: 0,
              end: 4,
              inverse: true,
              bold: true,
              fg: { rgb: "#010203" },
              bg: { palette: 4 },
            },
          ],
        },
        { attrs: [] },
        { attrs: [] },
      ],
    });
    if (first.reason === "unchanged" || second.reason === "unchanged")
      throw new Error("Changed observations must include the screen");
    expect(first.screen.map((line) => line.text)).toEqual(second.screen.map((line) => line.text));
    expect(first.screen[0]?.attrs).toEqual([]);
  } finally {
    await terminal.dispose();
  }
});

test("physical wrapped rows and normal history remain available while alternate is active", async () => {
  const terminal = model(4, 2);
  try {
    terminal.output(Buffer.from("12345\r\nH\r\nN"));
    expect(await terminal.observe({ tail: 1 }, false)).toMatchObject({
      active: "normal",
      screen: [
        { text: "H", wrapped: false },
        { text: "N", wrapped: false },
      ],
      tail: { buffer: "normal", omitted: 1, lines: [{ text: "5", wrapped: true }] },
    });
    terminal.output(Buffer.from("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2026hALT"));
    expect(await terminal.observe({ tail: 2 }, true)).toMatchObject({
      active: "alternate",
      cursor: { x: 3, y: 0, visible: false },
      synchronizedOutput: true,
      historyGap: true,
      screen: [{ text: "ALT" }, { text: "" }],
      tail: {
        buffer: "normal",
        omitted: 0,
        lines: [
          { text: "1234", wrapped: false },
          { text: "5", wrapped: true },
        ],
      },
    });
    terminal.output(Buffer.from("\x1b[?1049l\x1b[?2026l"));
    expect(await terminal.observe({}, false)).toMatchObject({
      active: "normal",
      synchronizedOutput: false,
      screen: [{ text: "H" }, { text: "N" }],
    });
  } finally {
    await terminal.dispose();
  }
});

test("change sees earlier output and epoch resets; input alone times out with the full screen", async () => {
  const terminal = model();
  try {
    const before = terminal.position();
    terminal.output(Buffer.from("READY"));
    await terminal.ordered(() => {});
    expect(
      await terminal.wait({ mode: "change", after: before }, false, Date.now() + 200),
    ).toMatchObject({ reason: "changed", snapshot: { screen: [{ text: "READY" }, {}, {}] } });
    expect(
      await terminal.wait(
        { mode: "change", after: { epoch: "previous", seq: 99 } },
        false,
        Date.now() + 200,
      ),
    ).toMatchObject({ reason: "reset", snapshot: { screen: [{ text: "READY" }, {}, {}] } });
    const current = terminal.position();
    const waiting = terminal.wait({ mode: "change", after: current }, false, Date.now() + 30);
    terminal.admitInput();
    expect(await waiting).toMatchObject({
      reason: "timeout",
      snapshot: { position: current, input: { inputSeq: 1 }, screen: [{ text: "READY" }, {}, {}] },
    });
  } finally {
    await terminal.dispose();
  }
});

test("quiet counts identical repaint activity and a shorter deadline returns the full screen", async () => {
  const terminal = model();
  let timer: NodeJS.Timeout | undefined;
  try {
    terminal.output(Buffer.from("SAME"));
    timer = setInterval(() => terminal.output(Buffer.from("\x1b[H")), 5);
    expect(
      await terminal.wait({ mode: "quiet", quietMs: 40 }, false, Date.now() + 100),
    ).toMatchObject({ reason: "timeout", snapshot: { screen: [{ text: "SAME" }, {}, {}] } });
    clearInterval(timer);
    expect(
      await terminal.wait({ mode: "quiet", quietMs: 40 }, false, Date.now() + 10),
    ).toMatchObject({ reason: "timeout", snapshot: { screen: [{ text: "SAME" }, {}, {}] } });
    expect(
      await terminal.wait({ mode: "quiet", quietMs: 20 }, false, Date.now() + 200),
    ).toMatchObject({ reason: "quiet", snapshot: { screen: [{ text: "SAME" }, {}, {}] } });
  } finally {
    clearInterval(timer);
    await terminal.dispose();
  }
});

test.each([
  {
    name: "quiet times out when the deadline precedes quiet and the timer runs late",
    quietMs: 80,
    timeoutMs: 20,
    expectedReason: "timeout",
  },
  {
    name: "quiet succeeds when quiet precedes the deadline and the timer runs late",
    quietMs: 20,
    timeoutMs: 80,
    expectedReason: "quiet",
  },
])("$name", async ({ quietMs, timeoutMs, expectedReason }) => {
  const terminal = model();
  const callbackDelayMs = 120;
  try {
    terminal.output(Buffer.from("READY"));
    await terminal.ordered(() => {});
    const waiting = terminal.wait({ mode: "quiet", quietMs }, false, Date.now() + timeoutMs);
    await terminal.ordered(() => {});
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      callbackDelayMs,
    );
    expect(await waiting).toMatchObject({
      reason: expectedReason,
      snapshot: { screen: [{ text: "READY" }, {}, {}] },
    });
  } finally {
    await terminal.dispose();
  }
});

test("quiet starts after queued parsing, even when parsing consumes the request deadline", async () => {
  const terminal = model(80, 24);
  try {
    terminal.output(Buffer.from("x".repeat(1024 * 1024)));
    let parsedAt = 0;
    void terminal.ordered(() => {
      parsedAt = Date.now();
    });
    const result = await terminal.wait({ mode: "quiet", quietMs: 30 }, false, Date.now() + 2000);
    expect(result.reason).toBe("quiet");
    expect(Date.now() - parsedAt).toBeGreaterThanOrEqual(30);
    void terminal.ordered(() => delay(50));
    terminal.output(Buffer.from("\r\nLAST"));
    const timedOut = await terminal.wait({ mode: "quiet", quietMs: 30 }, false, Date.now() + 10);
    expect(timedOut.reason).toBe("timeout");
    expect(timedOut.snapshot.screen).toHaveLength(24);
    expect(timedOut.snapshot.screen.some((line) => line.text === "LAST")).toBe(true);
  } finally {
    await terminal.dispose();
  }
});

test("dispose rejects an outstanding wait and subsequent observations", async () => {
  const terminal = model();
  const waiting = terminal.wait(
    { mode: "change", after: terminal.position() },
    false,
    Date.now() + 1000,
  );
  const rejection = expect(waiting).rejects.toMatchObject({ code: "recording_unavailable" });
  await terminal.dispose();
  await rejection;
  await expect(terminal.observe({}, false)).rejects.toMatchObject({
    code: "recording_unavailable",
  });
});

test("an oversized styled history rejects the snapshot and leaves recording usable", async () => {
  const faults: Error[] = [];
  const terminal = new Model(
    512,
    2,
    100,
    (error) => faults.push(error),
    () => {},
  );
  try {
    const line = "\x1b[31mx\x1b[32my".repeat(256);
    terminal.output(Buffer.from((line + "\r\n").repeat(60) + "\x1b[0m"));
    await expect(terminal.observe({ attrs: true, tail: 100 }, false)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    const before = terminal.position();
    terminal.admitInput();
    terminal.output(Buffer.from("STILL_ALIVE"));
    expect(await terminal.observe({}, false)).toMatchObject({
      reason: "full",
      position: { epoch: before.epoch, seq: before.seq + 1 },
      input: { inputSeq: 1 },
      screen: [{}, { text: "STILL_ALIVE" }],
    });
    expect(faults).toEqual([]);
  } finally {
    await terminal.dispose();
  }
});
