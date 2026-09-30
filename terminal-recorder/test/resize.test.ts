import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmux } from "@kiteline/shared/terminal/node";
import { RecordedSession } from "../src/session.js";

test("redraw keeps preceding Web and actual tmux sizes while the model parses output", async () => {
  const directory = await mkdtemp("/var/tmp/kiteline-resize-");
  const socket = directory + "/tmux.sock";
  const session = new RecordedSession(
    {
      type: "create",
      sessionId: "resize",
      socket,
      workspacePath: directory,
      shell: "/bin/bash",
      cols: 100,
      rows: 30,
      historyLines: 1000,
    },
    { channelPairTimeout: 3000, terminalInputBytes: 65536, terminalStallTimeout: 3000 },
    () => true,
    () => {},
  );
  const backlog = () => {
    for (let i = 0; i < 50; i++)
      session.model.output(Buffer.from("model backlog line ".repeat(1000) + "\r\n"));
  };
  const size = async () =>
    (await tmux(socket, ["display-message", "-p", "#{pane_width} #{pane_height}"])).trim();
  try {
    await session.start();
    backlog();
    session.input.resize("web", 130, 55);
    await session.input.redraw();
    expect(await size()).toBe("130 55");
    backlog();
    await session.control.resize(140, 60);
    await session.input.redraw();
    expect(await size()).toBe("140 60");
  } finally {
    await session.end();
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
