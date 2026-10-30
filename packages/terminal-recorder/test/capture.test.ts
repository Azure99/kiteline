import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { shellWords, tmux } from "@kiteline/shared/terminal/node";
import { Control } from "../src/control.js";
import { Model } from "../src/model.js";

test.each([
  { buffer: "normal", cursorVisible: true, applicationCursor: false },
  { buffer: "alternate", cursorVisible: false, applicationCursor: true },
])("capture restores the actual $buffer screen and input modes", async (sample) => {
  const directory = await mkdtemp("/var/tmp/kiteline-capture-");
  const socket = join(directory, "tmux.sock");
  const cols = 12;
  const rows = 3;
  const cursor = { x: 4, y: 1 };
  const firstLine = sample.buffer.toUpperCase();
  const lastLine = "LAST-ROW-END";
  const faults: Error[] = [];
  const output =
    (sample.buffer === "alternate" ? "\x1b[?1049h" : "") +
    `\x1b[H\x1b[2J\x1b[1;31m${firstLine}\x1b[0m` +
    "\x1b[2;1HREADY" +
    `\x1b[3;1H${lastLine}` +
    `\x1b[${cursor.y + 1};${cursor.x + 1}H` +
    `\x1b[?25${sample.cursorVisible ? "h" : "l"}` +
    `\x1b[?1${sample.applicationCursor ? "h" : "l"}`;
  const control = new Control(
    {
      type: "create",
      sessionId: "capture",
      socket,
      workspacePath: directory,
      shell: "/bin/bash",
      command: shellWords(["printf", "%s", output]) + "; exec sleep 60",
      cols,
      rows,
      historyLines: 100,
    },
    { output: () => {}, resize: () => {}, dead: () => {}, fault: (error) => faults.push(error) },
    3000,
  );
  const model = new Model(
    { cols: 1, rows: 1, historyLines: 100 },
    { fault: (error) => faults.push(error), backlogChanged: () => {} },
  );
  try {
    const identity = await control.start();
    const stateFormat =
      "size=#{pane_width}x#{pane_height} buffer=#{?alternate_on,alternate,normal} " +
      "cursor=#{cursor_x},#{cursor_y} visible=#{?cursor_flag,yes,no} " +
      "keys=#{?keypad_cursor_flag,application,normal}";
    const expectedState =
      `size=${cols}x${rows} buffer=${sample.buffer} cursor=${cursor.x},${cursor.y} ` +
      `visible=${sample.cursorVisible ? "yes" : "no"} ` +
      `keys=${sample.applicationCursor ? "application" : "normal"}`;
    await expect
      .poll(
        async () => ({
          state: (
            await tmux(socket, ["display-message", "-p", "-t", identity.paneId, stateFormat])
          ).trim(),
          lines: (await tmux(socket, ["capture-pane", "-p", "-t", identity.paneId]))
            .trimEnd()
            .split("\n"),
        }),
        { timeout: 3000 },
      )
      .toEqual({ state: expectedState, lines: [firstLine, "READY", lastLine] });

    const captured = await control.capture();
    model.resize(captured.cols, captured.rows);
    model.output(Buffer.from(captured.data));
    expect(await model.observe({ attrs: true }, true)).toMatchObject({
      cols,
      rows,
      active: sample.buffer,
      cursor: { ...cursor, visible: sample.cursorVisible },
      screen: [
        {
          text: firstLine,
          wrapped: false,
          attrs: [{ start: 0, end: firstLine.length, bold: true, fg: { palette: 1 } }],
        },
        { text: "READY", wrapped: false, attrs: [] },
        { text: lastLine, wrapped: false, attrs: [] },
      ],
    });
    expect(model.terminal.modes.applicationCursorKeysMode).toBe(sample.applicationCursor);
    expect(faults).toEqual([]);
  } finally {
    await control.close();
    await model.dispose();
    await tmux(socket, ["kill-server"]);
    await rm(directory, { recursive: true, force: true });
  }
});
