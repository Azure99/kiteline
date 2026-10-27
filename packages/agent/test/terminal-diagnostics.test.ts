import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { tmux } from "@kiteline/shared/terminal/node";

interface Message {
  id: string;
  socket?: string;
  recorderPid?: number;
  pending?: boolean;
  error?: { code: string; message: string; outcome: string };
}

test.skipIf(process.platform !== "linux")(
  "a late cleanup failure reaches Agent stderr without replacing a later recorder exit reason",
  async () => {
    const directory = await mkdtemp("/var/tmp/kiteline-terminal-diagnostics-");
    const child = fork(
      fileURLToPath(new URL("./support/terminal-diagnostics-child.mjs", import.meta.url)),
      [directory],
      { silent: true },
    );
    const closed = once(child, "exit");
    const messages: Message[] = [];
    let stderr = "";
    child.on("message", (message: Message) => messages.push(message));
    child.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
    let serverPid: number | undefined;
    let serverStopped = false;
    let recorderPid: number | undefined;
    let recorderStopped = false;
    const polling = { timeout: 5000, interval: 20 };
    try {
      await expect
        .poll(() => messages.find((message) => message.id === "ready"), polling)
        .toBeDefined();
      const ready = messages.find((message) => message.id === "ready")!;
      const socket = ready.socket!;
      recorderPid = ready.recorderPid!;
      serverPid = Number((await tmux(socket, ["display-message", "-p", "#{pid}"])).trim());
      process.kill(serverPid, "SIGSTOP");
      serverStopped = true;
      child.send({
        type: "send",
        id: "timed-out-send",
        text: "UNCONFIRMED",
        timeoutMs: 1500,
      });

      async function inputClientPid() {
        const ids = (await readFile(`/proc/${recorderPid}/task/${recorderPid}/children`, "utf8"))
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        for (const id of ids) {
          const args = await readFile(`/proc/${id}/cmdline`, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return "";
            },
          );
          const argv = args.split("\0");
          if (argv.includes(socket) && argv.includes("load-buffer")) return Number(id);
        }
      }
      await expect.poll(() => inputClientPid(), { timeout: 1000, interval: 10 }).toBeDefined();
      await expect
        .poll(() => messages.find((message) => message.id === "timed-out-send"), polling)
        .toMatchObject({
          error: { code: "timeout", outcome: "unknown" },
        });
      process.kill(serverPid, "SIGKILL");
      serverStopped = false;
      const diagnostic = `Could not delete input buffer kiteline-web-input on ${socket}: no server running`;
      await expect.poll(() => stderr, polling).toContain(diagnostic);
      expect(child.exitCode).toBe(null);
      expect(() => process.kill(recorderPid!, 0)).not.toThrow();
      expect(messages.filter((message) => message.id === "timed-out-send")).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({ code: "timeout", outcome: "unknown" }),
        }),
      ]);

      process.kill(recorderPid, "SIGSTOP");
      recorderStopped = true;
      child.send({ type: "pending-end", id: "killed-recorder" });
      await expect
        .poll(() => messages.find((message) => message.id === "killed-recorder"), polling)
        .toMatchObject({ pending: true });
      process.kill(recorderPid, "SIGKILL");
      recorderStopped = false;
      await expect
        .poll(
          () => messages.find((message) => message.id === "killed-recorder" && !message.pending),
          polling,
        )
        .toMatchObject({
          error: {
            code: "recording_unavailable",
            message: "Terminal recorder exited with signal SIGKILL",
            outcome: "unknown",
          },
        });
    } finally {
      if (serverStopped) process.kill(serverPid!, "SIGCONT");
      if (recorderStopped) process.kill(recorderPid!, "SIGCONT");
      if (child.connected) child.send({ type: "close" });
      try {
        expect(await closed).toEqual([0, null]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  15000,
);

test.skipIf(process.platform !== "linux").each([
  { name: "the exit code", invalidReply: false },
  { name: "an existing protocol failure", invalidReply: true },
])("recorder startup forwards stderr and reports $name", async ({ invalidReply }) => {
  const directory = await mkdtemp("/var/tmp/kiteline-terminal-diagnostics-");
  const marker = "RECORDER_FATAL_FIXTURE";
  const invalidJson = "NOT_JSON";
  await writeFile(
    join(directory, "recorder-preload.cjs"),
    `const { writeSync } = require("node:fs");
writeSync(2, ${JSON.stringify(marker + "\n")});
${invalidReply ? `writeSync(1, ${JSON.stringify(invalidJson + "\n")});` : ""}
process.exit(3);
`,
  );
  const child = fork(
    fileURLToPath(new URL("./support/terminal-diagnostics-child.mjs", import.meta.url)),
    [directory, "preload"],
    { silent: true },
  );
  const closed = once(child, "close");
  const messages: Message[] = [];
  let stderr = "";
  child.on("message", (message: Message) => messages.push(message));
  child.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
  try {
    expect(await closed).toEqual([0, null]);
    expect(stderr).toContain(marker);
    expect(messages).toEqual([
      {
        id: "create",
        error: {
          code: "recording_unavailable",
          message: invalidReply
            ? expect.stringContaining("is not valid JSON")
            : "Terminal recorder exited with code 3",
          outcome: "unknown",
        },
      },
    ]);
    if (invalidReply) expect(messages[0]!.error!.message).toContain(invalidJson);
    expect(messages[0]!.error!.message).not.toContain(marker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
