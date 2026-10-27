import { expect, test, vi } from "vitest";
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
    { terminalInputBytes: 65536 },
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

test("Web resize merging respects RPC boundaries and an ordered expiry retains its capacity", async () => {
  const directory = await mkdtemp("/var/tmp/kiteline-resize-queue-");
  const socket = directory + "/tmux.sock";
  const sizes: { cols: number; rows: number }[] = [];
  const inputCapacity = 128;
  const session = new RecordedSession(
    {
      type: "create",
      sessionId: "resize-queue",
      socket,
      workspacePath: directory,
      shell: "/bin/bash",
      command: "stty raw -echo; exec sleep 60",
      cols: 100,
      rows: 5,
      historyLines: 100,
    },
    { terminalInputBytes: inputCapacity },
    (message) => {
      if (message.type === "frame" && message.frame.type === "resize")
        sizes.push({ cols: message.frame.cols, rows: message.frame.rows });
      return true;
    },
    () => {},
  );
  const size = async () =>
    (await tmux(socket, ["display-message", "-p", "#{pane_width} #{pane_height}"])).trim();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ordered: ReturnType<typeof vi.spyOn> | undefined;
  let barrier: Promise<void> | undefined;
  try {
    await session.start();
    await session.attach("web", "screen", false);
    session.control.setPaused(true);
    session.input.resize("web", 110, 6);
    session.input.resize("web", 120, 7);
    const rpc = session.input
      .operation({
        type: "session.resize",
        cols: 130,
        rows: 8,
        deadline: Date.now() + 2000,
      })
      .then((result) => {
        expect([session.model.terminal.cols, session.model.terminal.rows]).toEqual([130, 8]);
        return result;
      });
    session.input.resize("web", 140, 9);
    session.input.resize("web", 150, 10);
    session.control.setPaused(false);
    expect(await rpc).toEqual({ cols: 130, rows: 8 });
    const last = await session.input.operation({
      type: "session.send",
      input: { type: "text", text: "" },
      deadline: Date.now() + 2000,
    });
    expect(last).toMatchObject({ input: { inputSeq: 1 } });
    expect(sizes).toEqual([
      { cols: 120, rows: 7 },
      { cols: 130, rows: 8 },
      { cols: 150, rows: 10 },
    ]);
    expect(await size()).toBe("150 10");

    barrier = session.model.ordered(() => blocked);
    ordered = vi.spyOn(session.model, "ordered");
    const expired = expect(
      session.input.operation({
        type: "session.resize",
        cols: 180,
        rows: 12,
        deadline: Date.now() + 300,
      }),
    ).rejects.toMatchObject({ code: "timeout", outcome: "failed" });
    await expect.poll(() => ordered!.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(0);
    ordered.mockRestore();
    await expired;
    const fullInput = () =>
      session.input.operation({
        type: "session.send",
        input: { type: "text", text: "x".repeat(inputCapacity) },
        deadline: Date.now() + 2000,
      });
    await expect(fullInput()).rejects.toMatchObject({ code: "limit_exceeded" });
    release();
    await session.input.operation({
      type: "session.send",
      input: { type: "text", text: "" },
      deadline: Date.now() + 2000,
    });
    await fullInput();
    expect(await size()).toBe("150 10");
    expect(sizes).toHaveLength(3);
  } finally {
    release();
    await barrier;
    ordered?.mockRestore();
    session.control.setPaused(false);
    await session.end();
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
