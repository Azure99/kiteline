import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { shellWords, tmux } from "@kiteline/shared/terminal/node";
import { terminalKeys } from "@kiteline/shared/protocol";
import { RecordedSession } from "../src/session.js";

async function receiver(bracketed = false, application = false) {
  const directory = await mkdtemp("/var/tmp/kiteline-send-bytes-");
  const fixture = directory + "/receive.cjs";
  const mode = `\x1b[?2004${bracketed ? "h" : "l"}\x1b[?1${application ? "h" : "l"}`;
  await writeFile(
    fixture,
    `const { writeFileSync } = require("node:fs");
let received = Buffer.alloc(0);
process.stdout.write(${JSON.stringify(mode + "READY")});
process.stdin.on("data", chunk => {
  received = Buffer.concat([received, chunk]);
  writeFileSync("received", received);
});
`,
  );
  const session = new RecordedSession(
    {
      type: "create",
      sessionId: "bytes",
      socket: directory + "/tmux.sock",
      workspacePath: directory,
      shell: "/bin/bash",
      command: "stty raw -echo; exec " + shellWords([process.execPath, fixture]),
      cols: 100,
      rows: 5,
      historyLines: 100,
    },
    { terminalInputBytes: 65536 },
    () => true,
    () => {},
  );
  return {
    session,
    directory,
    async ready() {
      await session.start();
      await expect
        .poll(
          async () => {
            const snapshot = await session.model.observe({}, false);
            return (
              snapshot.reason !== "unchanged" &&
              snapshot.screen.some((line) => line.text === "READY")
            );
          },
          { timeout: 2000 },
        )
        .toBe(true);
    },
    async close() {
      await session.end();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each([false, true])(
  "real tmux preserves text, paste and named key bytes (bracketed/application=%s)",
  async (modes) => {
    const fixture = await receiver(modes, modes);
    const { session } = fixture;
    const arrows = modes ? "O" : "[";
    const expected = Buffer.from(
      "Enter\r" +
        (modes ? "\x1b[200~a\rb\x1b[201~" : "a\rb") +
        "\r\r\x1b\x03\t" +
        `\x1b${arrows}A\x1b${arrows}B\x1b[5~\x1b[6~`,
    );
    try {
      await fixture.ready();
      const before = await session.model.observe({}, false);
      const first = await session.input.operation({
        type: "session.send",
        input: { type: "text", text: "Enter", enter: true },
        ifInput: before.input,
        deadline: Date.now() + 2000,
      });
      expect(first).toEqual({
        before: { epoch: before.position.epoch, seq: before.position.seq },
        input: { epoch: before.position.epoch, inputSeq: 1 },
      });
      await session.input.operation({
        type: "session.send",
        input: { type: "paste", text: "a\nb", enter: true },
        deadline: Date.now() + 2000,
      });
      for (const key of terminalKeys)
        await session.input.operation({
          type: "session.send",
          input: { type: "key", key },
          deadline: Date.now() + 2000,
        });
      await expect
        .poll(() => readFile(fixture.directory + "/received"), { timeout: 2000 })
        .toEqual(expected);
      expect(session.model.inputState().inputSeq).toBe(10);
      expect(await session.model.observe({ ifChanged: before.position }, false)).toMatchObject({
        reason: "unchanged",
        input: { inputSeq: 10 },
      });
    } finally {
      await fixture.close();
    }
  },
  10000,
);

test("a started resize expiry is unknown and the next real input waits for the shared queue", async () => {
  const fixture = await receiver();
  const { session } = fixture;
  const originalResize = session.control.resize.bind(session.control);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let resize: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await fixture.ready();
    resize = vi.spyOn(session.control, "resize").mockImplementation((cols, rows, signal) => {
      session.control.setPaused(true);
      started();
      return originalResize(cols, rows, signal);
    });
    const operation = session.input.operation({
      type: "session.resize",
      cols: 101,
      rows: 5,
      deadline: Date.now() + 50,
    });
    const expired = expect(operation).rejects.toMatchObject({
      code: "timeout",
      outcome: "unknown",
    });
    await entered;
    await expired;
    resize.mockRestore();
    const next = session.input.operation({
      type: "session.send",
      input: { type: "text", text: "AFTER" },
      deadline: Date.now() + 2000,
    });
    let sent = false;
    void next.then(() => {
      sent = true;
    });
    await session.model.ordered(() => {});
    expect(sent).toBe(false);
    expect(session.model.inputState().inputSeq).toBe(1);
    session.control.setPaused(false);
    await next;
    await expect
      .poll(() => readFile(fixture.directory + "/received"), { timeout: 2000 })
      .toEqual(Buffer.from("AFTER"));
  } finally {
    resize?.mockRestore();
    session.control.setPaused(false);
    await fixture.close();
  }
}, 10000);

test.skipIf(process.platform !== "linux")(
  "tmux abort waits for the actual client to close",
  async () => {
    const directory = await mkdtemp("/var/tmp/kiteline-tmux-close-");
    const socket = directory + "/tmux.sock";
    let clientPid: number | undefined;
    const abort = new AbortController();
    let settled = false;
    let operation: Promise<unknown> | undefined;
    try {
      await tmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "close-test"]);
      operation = tmux(socket, ["wait-for", "close-fence"], undefined, abort.signal).then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await expect
        .poll(
          async () => {
            const ids = (
              await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")
            )
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            for (const id of ids) {
              const args = (await readFile(`/proc/${id}/cmdline`, "utf8")).split("\0");
              if (args.includes(socket) && args.includes("close-fence")) clientPid = Number(id);
            }
            return clientPid !== undefined;
          },
          { timeout: 2000 },
        )
        .toBe(true);
      process.kill(clientPid!, "SIGSTOP");
      await expect
        .poll(async () => (await readFile(`/proc/${clientPid}/stat`, "utf8")).split(") ")[1]![0])
        .toBe("T");
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      process.kill(clientPid!, "SIGCONT");
      expect(await operation).toMatchObject({ name: "AbortError" });
      expect(settled).toBe(true);
      clientPid = undefined;
    } finally {
      if (clientPid) {
        process.kill(clientPid, "SIGCONT");
        abort.abort();
        await operation;
      }
      await tmux(socket, ["kill-server"]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);
