import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { readLines } from "@kiteline/shared/stdio";
import { tmux } from "@kiteline/shared/terminal/node";
import type { RecorderMessage, RecorderRequest, TerminalSource } from "@kiteline/shared/ipc";

test("create cancellation fences both same-chunk admission and a retiring recording", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-create-cancel-");
  const child = spawn(
    process.execPath,
    [
      resolve("terminal-recorder/dist/main.js"),
      "--agent",
      JSON.stringify({
        channelPairTimeout: 3000,
        terminalInputBytes: 65536,
        terminalStallTimeout: 3000,
      }),
    ],
    { stdio: "pipe" },
  );
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const replies = new Map<string, (message: RecorderMessage) => void>();
  const messages: RecorderMessage[] = [];
  child.stderr.resume();
  readLines(
    child.stdout,
    (line) => {
      const message = JSON.parse(line.toString()) as RecorderMessage;
      messages.push(message);
      if (message.type === "reply") replies.get(message.reply.id)?.(message);
    },
    (error) => {
      throw error;
    },
  );
  const wait = (id: string) => new Promise<RecorderMessage>((resolve) => replies.set(id, resolve));
  const send = (...values: RecorderRequest[]) =>
    child.stdin.write(values.map((value) => JSON.stringify(value) + "\n").join(""));
  const source = async (name: string, command: string): Promise<TerminalSource> => {
    const directory = join(root, name);
    await mkdir(directory);
    return {
      type: "create",
      sessionId: "one",
      socket: join(directory, "tmux.sock"),
      workspacePath: directory,
      shell: "/bin/bash",
      command,
      cols: 80,
      rows: 24,
      historyLines: 100,
    };
  };
  const first = await source("first", "printf late > late.txt");
  const live = await source("live", "exec sleep 60");
  const next = await source("next", "printf late > late.txt");
  try {
    const cancelled = wait("cancel-first");
    send(
      { ...first, id: "first" },
      { type: "cancelCreate", id: "cancel-first", sessionId: "one", createId: "first" },
    );
    expect(await cancelled).toMatchObject({ reply: { outcome: "succeeded" } });
    expect(messages).toContainEqual(
      expect.objectContaining({
        reply: expect.objectContaining({
          id: "first",
          outcome: "failed",
          error: expect.objectContaining({ code: "cancelled" }),
        }),
      }),
    );

    const created = wait("live");
    send({ ...live, id: "live" });
    expect(await created).toMatchObject({ reply: { outcome: "succeeded" } });
    const retired = wait("cancel-live");
    const nextCancelled = wait("cancel-next");
    send(
      { type: "cancelCreate", id: "cancel-live", sessionId: "one", createId: "live" },
      { ...next, id: "next" },
      { type: "cancelCreate", id: "cancel-next", sessionId: "one", createId: "next" },
    );
    expect(await retired).toMatchObject({ reply: { outcome: "succeeded" } });
    expect(await nextCancelled).toMatchObject({ reply: { outcome: "succeeded" } });
    expect(messages).toContainEqual(
      expect.objectContaining({
        reply: expect.objectContaining({
          id: "next",
          outcome: "failed",
          error: expect.objectContaining({ code: "cancelled" }),
        }),
      }),
    );
    child.stdin.end();
    await closed;
    for (const name of ["first", "next"])
      await expect(readFile(join(root, name, "late.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  } finally {
    child.kill("SIGKILL");
    await closed;
    for (const item of [first, live, next])
      await tmux(item.socket, ["kill-server"]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
