import { expect, test } from "vitest";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { limits } from "@kiteline/shared/protocol";
import type { TerminalEvent, TerminalFrame } from "@kiteline/shared/ipc";
import {
  mouseEncodingVT,
  adaptTerminalScrolling,
  terminalOptions,
} from "@kiteline/shared/terminal";
import { Model, type Snapshot } from "../src/model.js";
import { Attachment } from "../src/attachment.js";

function screen(cols = 80, rows = 24, history = 100, adapt = true) {
  const terminal = new headless.Terminal({ ...terminalOptions(history), cols, rows });
  const addon = new serialize.SerializeAddon();
  terminal.loadAddon(addon);
  if (adapt) adaptTerminalScrolling(terminal);
  return {
    terminal,
    text: () => addon.serialize() + mouseEncodingVT(terminal),
    write: (data: string | Uint8Array) =>
      new Promise<void>((resolve) => terminal.write(data, resolve)),
  };
}
async function apply(target: ReturnType<typeof screen>, event: TerminalEvent) {
  if (event.type === "output") await target.write(event.data);
  else target.terminal.resize(event.cols, event.rows);
}

test("batched output preserves UTF-8, non-ground recovery, resize and live order", async () => {
  const faults: Error[] = [];
  const model = new Model(80, 24, 100, (error) => faults.push(error));
  const reference = screen();
  const restored = screen();
  let snapshot!: Snapshot;
  const live: TerminalEvent[] = [];
  try {
    const block = "checkpoint line\r\n".repeat(4096);
    // Cross the automatic checkpoint boundary, then attach with an incomplete CSI.
    for (
      let offset = 0;
      offset < limits.terminalCheckpointIntervalBytes + block.length;
      offset += block.length
    ) {
      for (let i = 0; i < block.length; i += 1024)
        model.output(Buffer.from(block.slice(i, i + 1024)));
      await model.ordered(() => {});
      await reference.write(block);
    }
    model.resize(60, 20);
    reference.terminal.resize(60, 20);
    const unicode = Buffer.from("你好\x1b[3");
    for (const byte of unicode) model.output(Buffer.from([byte]));
    await reference.write(unicode);
    await model.attach(
      "retained",
      3000,
      (value) => (snapshot = value),
      (event) => live.push(event),
      new AbortController().signal,
    );
    expect(snapshot.data.toString()).toContain("checkpoint line");
    model.output(Buffer.from("1mred"));
    await Promise.resolve();
    model.output(Buffer.from("\x1b[0m\r\n"));
    model.resize(47, 13);
    model.output(Buffer.from("after resize\r\n\x1b[?1006h"));
    await model.ordered(() => {});
    expect(
      live
        .map((event) => (event.type === "output" ? event.data : `<${event.cols}x${event.rows}>`))
        .join(""),
    ).toBe("1mred\x1b[0m\r\n<47x13>after resize\r\n\x1b[?1006h");
    await reference.write("1mred\x1b[0m\r\n");
    reference.terminal.resize(47, 13);
    await reference.write("after resize\r\n\x1b[?1006h");

    restored.terminal.resize(snapshot.cols, snapshot.rows);
    await restored.write(snapshot.data);
    for (const event of [...snapshot.tail, ...live]) await apply(restored, event);
    expect(restored.text()).toBe(reference.text());
    expect(restored.terminal.buffer.active.cursorX).toBe(reference.terminal.buffer.active.cursorX);
    expect(restored.terminal.buffer.active.cursorY).toBe(reference.terminal.buffer.active.cursorY);
    expect(faults).toEqual([]);
  } finally {
    await model.dispose();
    reference.terminal.dispose();
    restored.terminal.dispose();
  }
});

test("recovery respects the ACK window before tail, ready, live output, resize and end", () => {
  const sent: (Buffer | TerminalFrame)[] = [];
  let closed = false;
  const attachment = new Attachment(
    "window",
    3000,
    (piece) => {
      sent.push(piece);
      return true;
    },
    () => (closed = true),
  );
  const data = Buffer.alloc(limits.terminalOutstandingBytes * 2 + 7, 65);
  const byteCount = () =>
    sent.reduce((total, piece) => total + (Buffer.isBuffer(piece) ? piece.length : 0), 0);
  try {
    attachment.start(
      { data, cols: 80, rows: 24, historyLimited: false, tail: [{ type: "output", data: "TAIL" }] },
      100,
      false,
    );
    expect(byteCount()).toBe(limits.terminalOutstandingBytes);
    expect(sent.some((piece) => !Buffer.isBuffer(piece) && piece.type === "ready")).toBe(false);
    attachment.output({ type: "output", data: "LIVE" });
    attachment.output({ type: "resize", cols: 40, rows: 12 });
    attachment.end(0);
    for (let step = 0; step < 8 && !closed; step++) attachment.acknowledge(byteCount());
    expect(closed).toBe(true);
    expect(Buffer.concat(sent.filter(Buffer.isBuffer))).toEqual(
      Buffer.concat([data, Buffer.from("TAILLIVE")]),
    );
    expect(
      sent
        .filter((piece): piece is TerminalFrame => !Buffer.isBuffer(piece))
        .map((piece) => piece.type),
    ).toEqual(["restore.begin", "ready", "resize", "ended"]);
    const ready = sent.findIndex((piece) => !Buffer.isBuffer(piece) && piece.type === "ready");
    expect(Buffer.concat(sent.slice(0, ready).filter(Buffer.isBuffer))).toEqual(
      Buffer.concat([data, Buffer.from("TAIL")]),
    );
  } finally {
    attachment.close();
  }
});

test("periodic checkpoints retain a bounded incomplete OSC after total output crosses the tail budget", async () => {
  const faults: Error[] = [];
  const model = new Model(80, 24, 100, (error) => faults.push(error));
  const restored = screen();
  let snapshot!: Snapshot;
  const live: TerminalEvent[] = [];
  try {
    const chunk = "ground line\r\n".repeat(4000);
    let groundBytes = 0;
    while (groundBytes <= limits.terminalCheckpointIntervalBytes) {
      model.output(Buffer.from(chunk));
      await model.ordered(() => {});
      groundBytes += Buffer.byteLength(chunk);
    }
    // No explicit checkpoint or attach may mask a delayed automatic rotation.
    const unfinished = "\x1b]0;" + "x".repeat(limits.terminalCheckpointIntervalBytes);
    for (let offset = 0; offset < unfinished.length; offset += limits.dataChunkBytes) {
      model.output(Buffer.from(unfinished.slice(offset, offset + limits.dataChunkBytes)));
      await model.ordered(() => {});
    }
    expect(groundBytes + Buffer.byteLength(unfinished)).toBeGreaterThan(
      limits.terminalRecoveryTailBytes,
    );
    await model.attach(
      "retained",
      1000,
      (value) => {
        snapshot = value;
      },
      (event) => live.push(event),
      new AbortController().signal,
    );
    expect(snapshot.data.toString()).toContain("ground line");
    expect(snapshot.tail.map((event) => (event.type === "output" ? event.data : "")).join("")).toBe(
      unfinished,
    );
    expect(
      snapshot.tail.reduce(
        (bytes, event) => bytes + (event.type === "output" ? Buffer.byteLength(event.data) : 32),
        0,
      ),
    ).toBeLessThan(limits.terminalRecoveryTailBytes);
    await restored.write(snapshot.data);
    for (const event of snapshot.tail) await apply(restored, event);
    model.output(Buffer.from("\x07\x1b[31mAFTER\x1b[0m\r\n"));
    await model.ordered(() => {});
    for (const event of live) await apply(restored, event);
    const expected = new serialize.SerializeAddon();
    model.terminal.loadAddon(expected);
    expect(restored.text()).toBe(expected.serialize() + mouseEncodingVT(model.terminal));
    expect(restored.terminal.buffer.active.cursorX).toBe(model.terminal.buffer.active.cursorX);
    expect(restored.terminal.buffer.active.cursorY).toBe(model.terminal.buffer.active.cursorY);
    expect(faults).toEqual([]);
  } finally {
    await model.dispose();
    restored.terminal.dispose();
  }
});

test("reattaching preserves snapshots across unchanged, mode-only and resized states", async () => {
  const model = new Model(40, 10, 100, (error) => {
    throw error;
  });
  const capture = async (history: "retained" | "screen" = "retained") => {
    let snapshot!: Snapshot;
    const detach = await model.attach(
      history,
      3000,
      (value) => {
        snapshot = value;
      },
      () => {},
      new AbortController().signal,
    );
    detach();
    return snapshot;
  };
  const restored = screen(40, 10, 100);
  try {
    model.output(Buffer.from("old line\r\n".repeat(25) + "CURRENT"));
    const initial = await capture();
    const savedBytes = Buffer.from(initial.data);
    model.resize(40, 10);
    expect(await capture()).toEqual(initial);
    model.output(Buffer.from("\x1b[?1006h\x1b[?1002h"));
    const modes = await capture();
    expect(modes.data.toString()).toContain("\x1b[?1006h");
    expect(modes.data).not.toEqual(initial.data);
    model.resize(30, 8);
    model.output(Buffer.from("\x1b[3"));
    const partial = await capture();
    expect(partial.cols).toBe(40);
    expect(partial.tail).toEqual([
      { type: "resize", cols: 30, rows: 8 },
      { type: "output", data: "\x1b[3" },
    ]);
    model.output(Buffer.from("1mNEW\x1b[0m"));
    const next = await capture();
    expect(next.cols).toBe(30);
    expect(next.rows).toBe(8);
    const screenOnly = await capture("screen");
    expect(screenOnly.data.length).toBeLessThan(next.data.length);
    expect(await capture()).toEqual(next);
    expect(initial.data).toEqual(savedBytes);
    expect(initial.tail).toEqual([]);
    expect(partial.tail).toEqual([
      { type: "resize", cols: 30, rows: 8 },
      { type: "output", data: "\x1b[3" },
    ]);
    restored.terminal.resize(next.cols, next.rows);
    await restored.write(next.data);
    expect(restored.terminal.buffer.active.cursorX).toBe(model.terminal.buffer.active.cursorX);
    expect(restored.terminal.buffer.active.cursorY).toBe(model.terminal.buffer.active.cursorY);
    expect(restored.text()).toContain("NEW");
  } finally {
    await model.dispose();
    restored.terminal.dispose();
  }
});

test("coalescing still rejects a real parser backlog above its byte budget", async () => {
  const faults: Error[] = [];
  const model = new Model(80, 24, 100, (error) => faults.push(error));
  try {
    const chunk = Buffer.alloc(limits.dataChunkBytes / 4, 65);
    for (let bytes = 0; bytes <= limits.terminalModelPendingBytes; bytes += chunk.length)
      model.output(chunk);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ code: "limit_exceeded" });
  } finally {
    await model.dispose();
  }
});

test.each([
  { history: 5, region: "", count: 3 },
  { history: 0, region: "", count: 1000000 },
  { history: 5, region: "", count: 1000000 },
  { history: 5, region: "\x1b[1;4r", count: 1000000, height: 4 },
  { history: 5, region: "\x1b[2;4r", count: 20, fallback: true },
  { history: 5, region: "\x1b[?1049h", count: 20, fallback: true },
])(
  "scrolling retains the finite screen and saved cursor: $history / $region",
  async ({ history, region, count, fallback = false, height = 6 }) => {
    const actual = screen(20, 6, history);
    const expected = screen(20, 6, history, !fallback);
    try {
      const prefix =
        "\x1b[31mone\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\x1b[0m" + region + "\x1b[2;2H\x1b7";
      await actual.write(prefix + `\x1b[${count}S` + "\x1b8END");
      const scrolls = fallback ? `\x1b[${count}S` : "\x1b[S".repeat(Math.min(count, height));
      await expected.write(prefix + scrolls + "\x1b8END");
      expect(actual.text()).toBe(expected.text());
      expect(actual.terminal.buffer.active.cursorY).toBe(expected.terminal.buffer.active.cursorY);
    } finally {
      actual.terminal.dispose();
      expected.terminal.dispose();
    }
  },
);

test.each([
  { final: "T", region: "" },
  { final: "^", region: "\x1b[2;5r" },
  { final: "L", region: "\x1b[2;5r" },
  { final: "M", region: "\x1b[?1049h\x1b[2;5r" },
  { final: "S", region: "\x1b[?1049h" },
  { final: "S", region: "\x1b[2;5r" },
])("bounded $final delegates screen and cursor behavior in $region", async ({ final, region }) => {
  for (const count of ["", "0", "1", "20", "2000"]) {
    for (const row of [1, 3, 6]) {
      const actual = screen(20, 6, 15);
      const expected = screen(20, 6, 15, false);
      try {
        const prefix =
          "old history\r\n".repeat(20) +
          region +
          "\x1b[31mone\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\x1b[0m" +
          `\x1b[${row};2H\x1b7`;
        await actual.write(prefix + `\x1b[${count}`);
        await actual.write(final + "\x1b8END");
        await expected.write(prefix + `\x1b[${count}${final}` + "\x1b8END");
        expect(actual.text()).toBe(expected.text());
        expect(actual.terminal.buffer.active.cursorX).toBe(expected.terminal.buffer.active.cursorX);
        expect(actual.terminal.buffer.active.cursorY).toBe(expected.terminal.buffer.active.cursorY);
        expect(actual.terminal.buffer.normal.baseY).toBe(expected.terminal.buffer.normal.baseY);
      } finally {
        actual.terminal.dispose();
        expected.terminal.dispose();
      }
    }
  }
});

test.each(["", "0", "1", "8", "9", "10", "2147483647"])(
  "REP bounds ASCII repetition at the right edge: %s",
  async (count) => {
    const actual = screen(10, 3, 20);
    const expected = screen(10, 3, 20, false);
    try {
      await actual.write(`a\x1b[${count}b`);
      await expected.write("a".repeat(1 + Math.min(Number(count) || 1, 9)));
      expect(actual.text()).toBe(expected.text());
      expect(actual.terminal.buffer.active.cursorX).toBe(expected.terminal.buffer.active.cursorX);
      expect(actual.terminal.buffer.normal.baseY).toBe(0);
    } finally {
      actual.terminal.dispose();
      expected.terminal.dispose();
    }
  },
);

test.each(["", "0", "2147483647"])("REP preserves pending wrap: %s", async (count) => {
  const actual = screen(10, 3, 20);
  const expected = screen(10, 3, 20, false);
  try {
    await actual.write(`xxxxxxxxxx\x1b[${count}b`);
    expect(actual.terminal.buffer.active.cursorX).toBe(10);
    expect(actual.terminal.buffer.active.cursorY).toBe(0);
    await actual.write("Z");
    await expected.write("xxxxxxxxxxZ");
    expect(actual.text()).toBe(expected.text());
    expect(actual.terminal.buffer.active.cursorX).toBe(1);
    expect(actual.terminal.buffer.active.cursorY).toBe(1);
  } finally {
    actual.terminal.dispose();
    expected.terminal.dispose();
  }
});

test.each([
  { name: "ASCII", prefix: "A" },
  { name: "DEC", prefix: "\x1b(0q" },
  { name: "wide", prefix: "界" },
  { name: "pending wrap", prefix: "x".repeat(20) },
])("REP after a $name checkpoint matches continuous output", async ({ prefix }) => {
  const faults: Error[] = [];
  const model = new Model(20, 6, 100, (error) => faults.push(error));
  const restored = screen(20, 6, 100);
  const serialized = new serialize.SerializeAddon();
  model.terminal.loadAddon(serialized);
  let snapshot!: Snapshot;
  const live: TerminalEvent[] = [];
  try {
    model.output(Buffer.from("\x1b[31mold\r\n".repeat(8) + "\x1b[0m" + prefix));
    await model.attach(
      "retained",
      1000,
      (value) => (snapshot = value),
      (event) => live.push(event),
      new AbortController().signal,
    );
    expect(snapshot.tail).toEqual([]);
    expect(snapshot.data.toString()).toContain("old");
    await restored.write(snapshot.data);
    for (const suffix of ["\x1b[2147483647b", "Z\r\nAFTER"]) {
      model.output(Buffer.from(suffix));
      await model.ordered(() => {});
      for (const event of live.splice(0)) await apply(restored, event);
      expect(restored.text()).toBe(serialized.serialize() + mouseEncodingVT(model.terminal));
      const actual = restored.terminal.buffer.active;
      const expected = model.terminal.buffer.active;
      expect([actual.cursorX, actual.cursorY, actual.baseY, actual.length]).toEqual([
        expected.cursorX,
        expected.cursorY,
        expected.baseY,
        expected.length,
      ]);
      for (let row = 0; row < expected.length; row++)
        expect(actual.getLine(row)?.isWrapped).toBe(expected.getLine(row)?.isWrapped);
      expect(restored.terminal.modes).toEqual(model.terminal.modes);
    }
    expect(faults).toEqual([]);
  } finally {
    await model.dispose();
    restored.terminal.dispose();
  }
});

test("disposing adaptation restores the original scroll and REP behavior", async () => {
  const actual = screen(10, 3, 20, false);
  const expected = screen(10, 3, 20, false);
  const adaptation = adaptTerminalScrolling(actual.terminal);
  try {
    await actual.write("a\x1b[95b");
    await expected.write("a".repeat(10));
    expect(actual.text()).toBe(expected.text());
    expect(actual.terminal.buffer.normal.baseY).toBe(0);
    adaptation.dispose();
    await actual.write("\r\nb\x1b[95b\x1b[2S\x1b[20T");
    await expected.write("\r\nb\x1b[95b\x1b[2S\x1b[20T");
    expect(actual.text()).toBe(expected.text());
    expect(actual.terminal.buffer.normal.baseY).toBeGreaterThan(3);
  } finally {
    actual.terminal.dispose();
    expected.terminal.dispose();
  }
});
