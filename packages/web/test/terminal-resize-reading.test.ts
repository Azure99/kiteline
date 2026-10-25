import { afterEach, expect, test } from "vitest";
import { Terminal } from "@xterm/xterm";

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

function createTerminal(options: { cols: number; rows: number; scrollback: number }): Terminal {
  const terminal = new Terminal(options);
  terminals.push(terminal);
  return terminal;
}

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

function visibleLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.viewportY + row)!.translateToString(true),
  );
}

function findLine(terminal: Terminal, text: string): number {
  const buffer = terminal.buffer.active;
  for (let index = 0; index < buffer.length; index++)
    if (buffer.getLine(index)!.translateToString(true).includes(text)) return index;
  throw new Error(`Missing terminal fixture text: ${text}`);
}

test("mixed long and short output keeps the reading line through column and row changes", async () => {
  const terminal = createTerminal({ cols: 180, rows: 42, scrollback: 5000 });
  const digits = "0123456789".repeat(45);
  const command = `for n in {1..60}; do printf 'MIX_W_20261023 %03d ${digits}\\n' "$n"; done; for n in {1..280}; do printf 'MIX_S_20261023 %03d reading\\n' "$n"; done; printf 'MIX_DONE_20261023 END\\n'`;
  await write(
    terminal,
    [
      `$ ${command}`,
      ...Array.from(
        { length: 60 },
        (_, index) => `MIX_W_20261023 ${String(index + 1).padStart(3, "0")} ${digits}`,
      ),
      ...Array.from(
        { length: 280 },
        (_, index) => `MIX_S_20261023 ${String(index + 1).padStart(3, "0")} reading`,
      ),
      "MIX_DONE_20261023 END",
      "$ ",
    ].join("\r\n"),
  );
  const reading = "MIX_S_20261023 077 reading";
  // This positions a Node buffer fixture; browser wheel input is tested separately.
  terminal.scrollToLine(findLine(terminal, reading));
  expect(visibleLines(terminal)[0]).toBe(reading);

  for (const [cols, rows] of [
    [139, 42],
    [139, 11],
    [210, 11],
  ] as const) {
    terminal.resize(cols, rows);
    expect(terminal.buffer.active.viewportY).toBe(findLine(terminal, reading));
    expect(visibleLines(terminal)[0]).toBe(reading);
  }
});

test("growing near the bottom clamps legally and later output preserves the new reading line", async () => {
  const terminal = createTerminal({ cols: 138, rows: 11, scrollback: 5000 });
  await write(
    terminal,
    [
      "$ seq -f 'READ-%03g' 1 280",
      ...Array.from({ length: 280 }, (_, index) => `READ-${String(index + 1).padStart(3, "0")}`),
      "$ printf 'PENDING-READING-PROOF\\n'",
    ].join("\r\n"),
  );
  terminal.scrollToLine(findLine(terminal, "READ-261"));
  expect(visibleLines(terminal)[0]).toBe("READ-261");
  expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY);

  terminal.resize(138, 24);
  expect(terminal.buffer.active.viewportY).toBeLessThanOrEqual(terminal.buffer.active.baseY);
  expect(visibleLines(terminal)).toContain("READ-261");
  const clampedReading = visibleLines(terminal)[0];

  terminal.resize(138, 11);
  expect(visibleLines(terminal)[0]).toBe(clampedReading);
  const baseBeforeOutput = terminal.buffer.active.baseY;
  await write(terminal, "AFTER-READ\r\n");
  expect(terminal.buffer.active.baseY).toBeGreaterThan(baseBeforeOutput);
  expect(visibleLines(terminal)[0]).toBe(clampedReading);
});

test("wide-character reading and wrapped continuations stay in the original logical group", async () => {
  const terminal = createTerminal({ cols: 12, rows: 5, scrollback: 200 });
  await write(
    terminal,
    Array.from({ length: 20 }, (_, index) => `GROUP-${index}:界界界界界界界界界界界界`).join(
      "\r\n",
    ) + "\r\n",
  );
  terminal.scrollToLine(findLine(terminal, "GROUP-3"));
  expect(visibleLines(terminal)[0]).toContain("GROUP-3:");

  for (const cols of [9, 18]) {
    terminal.resize(cols, 5);
    expect(terminal.buffer.active.viewportY).toBe(findLine(terminal, "GROUP-3"));
    expect(visibleLines(terminal)[0]).toContain("GROUP-3:");
  }

  terminal.scrollToLine(findLine(terminal, "GROUP-5") + 1);
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.isWrapped).toBe(true);
  expect(visibleLines(terminal)[0]).toBe("界".repeat(7));

  terminal.resize(10, 7);
  // GROUP-5: occupies eight cells. The old continuation starts at cell 18,
  // which belongs to the second physical row at ten columns.
  expect(terminal.buffer.active.viewportY).toBe(findLine(terminal, "GROUP-5") + 1);
  expect(visibleLines(terminal)[0]).toBe("界".repeat(5));
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.isWrapped).toBe(true);
});

test("identical logical lines preserve their physical position instead of matching earlier text", async () => {
  const terminal = createTerminal({ cols: 20, rows: 6, scrollback: 1000 });
  await write(
    terminal,
    Array.from({ length: 100 }, () => "DUPLICATE ".repeat(8)).join("\r\n") + "\r\n",
  );
  terminal.scrollToLine(81);
  expect(terminal.buffer.active.viewportY).toBe(81);

  // Each identical logical line has 80 cells: four rows at 20 columns and
  // eight rows at 10 columns. Row 81 therefore maps to 162, then back to 81.
  terminal.resize(10, 6);
  expect(terminal.buffer.active.viewportY).toBe(162);
  terminal.resize(20, 6);
  expect(terminal.buffer.active.viewportY).toBe(81);
});

test("a continuation maps to the new row containing the previous first cell", async () => {
  const terminal = createTerminal({ cols: 12, rows: 5, scrollback: 1000 });
  const logical = "SEQUENCE-5:abcdefghijklmnopqrstuvwxyz0123456789";
  await write(
    terminal,
    Array.from(
      { length: 20 },
      (_, index) => `SEQUENCE-${index}:abcdefghijklmnopqrstuvwxyz0123456789`,
    ).join("\r\n") + "\r\n",
  );
  terminal.scrollToLine(findLine(terminal, "SEQUENCE-5") + 1);
  expect(visibleLines(terminal)[0]).toBe(logical.slice(12, 24));

  terminal.resize(8, 5);
  expect(visibleLines(terminal)[0]).toBe(logical.slice(8, 16));
  terminal.resize(20, 5);
  expect(visibleLines(terminal)[0]).toBe(logical.slice(0, 20));
});

async function createTrimTerminal(): Promise<Terminal> {
  const terminal = createTerminal({ cols: 20, rows: 5, scrollback: 30 });
  await write(
    terminal,
    Array.from({ length: 30 }, (_, index) => `TRIM-${index}-${"x".repeat(30)}`).join("\r\n") +
      "\r\n",
  );
  terminal.scrollToLine(1);
  return terminal;
}

test("a reading group trimmed by reflow falls back to the earliest retained content", async () => {
  const terminal = await createTrimTerminal();
  const buffer = terminal.buffer.active;
  const readingGroup = buffer
    .getLine(0)!
    .translateToString(true)
    .match(/^TRIM-\d+-/)?.[0];
  expect(readingGroup).toBeDefined();
  expect(buffer.viewportY).toBe(1);
  expect(buffer.getLine(buffer.viewportY)!.isWrapped).toBe(true);

  terminal.resize(5, 5);
  const retained = terminal.buffer.active;
  const retainedText = Array.from({ length: retained.length }, (_, index) =>
    retained.getLine(index)!.translateToString(true),
  ).join("");
  expect(retainedText).not.toContain(readingGroup);
  expect(retained.viewportY).toBe(0);
  expect(visibleLines(terminal)[0]).toBe(retained.getLine(0)!.translateToString(true));
});

test("resizing the alternate buffer keeps its visible content and zero scrollback", async () => {
  const terminal = await createTrimTerminal();
  terminal.resize(5, 5);
  await write(terminal, "\x1b[?1049hALT\r\n");
  terminal.resize(7, 7);

  expect(terminal.buffer.active.type).toBe("alternate");
  expect(terminal.buffer.active.baseY).toBe(0);
  expect(visibleLines(terminal)).toContain("ALT");
});
