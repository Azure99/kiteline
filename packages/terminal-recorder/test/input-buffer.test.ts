import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AppError } from "@kiteline/shared/protocol";
import { tmux } from "@kiteline/shared/terminal/node";
import { isMissingInputBuffer, webInputBuffer } from "../src/input.js";

test.skipIf(process.platform === "win32")(
  "only the exact private-buffer missing error is ignored, and deletion preserves user buffers",
  async () => {
    const directory = await mkdtemp("/var/tmp/kiteline-input-buffer-");
    const socket = join(directory, "tmux.sock");
    let started = false;
    try {
      await tmux(socket, ["new-session", "-d", "-s", "input-buffer", "/bin/sh"]);
      started = true;
      const remove = () => tmux(socket, ["delete-buffer", "-b", webInputBuffer]);
      const missing = await remove().catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(AppError);
      expect(missing).toMatchObject({
        code: "command_failed",
        message: `unknown buffer: ${webInputBuffer}`,
      });
      expect(isMissingInputBuffer(missing)).toBe(true);
      await tmux(socket, [
        "set-buffer",
        "-b",
        "user-copy",
        "keep",
        ";",
        "set-buffer",
        "-b",
        webInputBuffer,
        "stale",
      ]);
      await expect(remove()).resolves.toBe("");
      const repeated = await remove().catch((error: unknown) => error);
      expect(isMissingInputBuffer(repeated)).toBe(true);
      expect(await tmux(socket, ["show-buffer", "-b", "user-copy"])).toBe("keep");
      for (const error of [
        new Error(`unknown buffer: ${webInputBuffer}`),
        new AppError("io_error", `unknown buffer: ${webInputBuffer}`),
        new AppError("command_failed", "unknown buffer: user-copy"),
        new AppError("command_failed", `unknown buffer: ${webInputBuffer}\nextra`),
        new AppError("command_failed", "no server running"),
      ])
        expect(isMissingInputBuffer(error)).toBe(false);
    } finally {
      try {
        if (started) await tmux(socket, ["kill-server"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
