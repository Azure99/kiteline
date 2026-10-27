import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { shellWords, tmux } from "@kiteline/shared/terminal/node";
import { terminalKeys } from "@kiteline/shared/protocol";
import { modelLimits } from "../src/model.js";
import { RecordedSession } from "../src/session.js";

async function receiver({
  bracketedPaste = false,
  applicationCursorKeys = false,
  terminalInputBytes = 65536,
}: {
  bracketedPaste?: boolean;
  applicationCursorKeys?: boolean;
  terminalInputBytes?: number;
} = {}) {
  const directory = await mkdtemp("/var/tmp/kiteline-send-bytes-");
  const fixture = directory + "/receive.cjs";
  const mode = `\x1b[?2004${bracketedPaste ? "h" : "l"}\x1b[?1${applicationCursorKeys ? "h" : "l"}`;
  await writeFile(
    fixture,
    `const { watch, writeFileSync } = require("node:fs");
let received = Buffer.alloc(0);
writeFileSync("received", received);
const modes = watch(".", (_event, name) => {
  if (name !== "application-mode") return;
  modes.close();
  process.stdout.write("\\x1b[?1hMODE_CHANGED");
});
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
    { terminalInputBytes },
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
    const fixture = await receiver({
      bracketedPaste: modes,
      applicationCursorKeys: modes,
    });
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

test("parser pressure pauses at high water and resumes only below low water before real input", async () => {
  const fixture = await receiver();
  const { session } = fixture;
  const highWater = modelLimits.terminalModelHighWaterBytes;
  const lowWater = modelLimits.terminalModelLowWaterBytes;
  const pressure: { backlog: number; paused: boolean }[] = [];
  const setPaused = session.control.setPaused.bind(session.control);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pause: ReturnType<typeof vi.spyOn> | undefined;
  let barrier: Promise<void> | undefined;
  try {
    await fixture.ready();
    pause = vi.spyOn(session.control, "setPaused").mockImplementation((paused) => {
      pressure.push({ backlog: session.model.backlog, paused });
      setPaused(paused);
    });
    barrier = session.model.ordered(() => blocked);
    session.model.output(Buffer.alloc(highWater - lowWater, "x"));
    // Separate parsing batches so their completion leaves exactly low water, then one byte less.
    void session.model.ordered(() => {});
    session.model.output(Buffer.from("x"));
    void session.model.ordered(() => {});
    session.model.output(Buffer.alloc(lowWater - 1, "x"));
    expect(pressure).toContainEqual({ backlog: highWater, paused: true });

    release();
    await session.model.ordered(() => {});
    expect(pressure).toContainEqual({ backlog: lowWater, paused: true });
    expect(pressure).toContainEqual({ backlog: lowWater - 1, paused: false });
    await session.input.operation({
      type: "session.send",
      input: { type: "text", text: "AFTER_PRESSURE" },
      deadline: Date.now() + 2000,
    });
    await expect
      .poll(() => readFile(fixture.directory + "/received", "utf8"), { timeout: 2000 })
      .toBe("AFTER_PRESSURE");
  } finally {
    release();
    await barrier;
    pause?.mockRestore();
    session.control.setPaused(false);
    await fixture.close();
  }
}, 10000);

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

test("mixed Web and RPC inputs retain other attachments and omit detached or expired bytes", async () => {
  const fixture = await receiver();
  const { session } = fixture;
  try {
    await fixture.ready();
    session.control.setPaused(true);
    session.input.input("drop", Buffer.from("DROP-1"));
    session.input.input("keep", Buffer.from("a"));
    session.input.input("keep", Buffer.from("b"));
    session.input.paste("keep", "p\nq");
    session.input.paste("drop", "DROP-2");
    const retained = session.input.operation({
      type: "session.send",
      input: { type: "text", text: "RPC" },
      deadline: Date.now() + 2000,
    });
    session.input.input("keep", Buffer.from("c"));
    const expires = expect(
      session.input.operation({
        type: "session.send",
        input: { type: "text", text: "EXPIRED" },
        deadline: Date.now() + 50,
      }),
    ).rejects.toMatchObject({ code: "timeout", outcome: "failed" });
    session.input.input("keep", Buffer.from("d"));
    session.input.input("drop", Buffer.from("DROP-3"));
    session.input.detach("drop");
    expect(session.model.inputState().inputSeq).toBe(10);
    await expires;
    session.control.setPaused(false);
    await retained;
    const last = await session.input.operation({
      type: "session.send",
      input: { type: "text", text: "TAIL" },
      deadline: Date.now() + 2000,
    });
    expect(last).toMatchObject({ input: { inputSeq: 11 } });
    await expect
      .poll(() => readFile(fixture.directory + "/received"), { timeout: 2000 })
      .toEqual(Buffer.from("abp\rqRPCcdTAIL"));
  } finally {
    session.control.setPaused(false);
    await fixture.close();
  }
}, 10000);

test("a queued arrow uses the producer's new mode and the preceding ordered output position", async () => {
  const fixture = await receiver();
  const { session } = fixture;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let output: ReturnType<typeof vi.spyOn> | undefined;
  let barrier: Promise<void> | undefined;
  try {
    await fixture.ready();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    barrier = session.model.ordered(() => {
      entered();
      return blocked;
    });
    await waiting;
    const originalOutput = session.model.output.bind(session.model);
    let delivered = "";
    output = vi.spyOn(session.model, "output").mockImplementation((data) => {
      originalOutput(data);
      delivered += data.toString();
    });
    await writeFile(fixture.directory + "/application-mode", "");
    await expect.poll(() => delivered.includes("MODE_CHANGED"), { timeout: 2000 }).toBe(true);
    expect(session.model.terminal.modes.applicationCursorKeysMode).toBe(false);
    const before = session.model.ordered(() => session.model.position());
    const operation = session.input.operation({
      type: "session.send",
      input: { type: "key", key: "Up" },
      deadline: Date.now() + 2000,
    });
    release();
    expect(await operation).toMatchObject({ before: await before, input: { inputSeq: 1 } });
    expect(session.model.terminal.modes.applicationCursorKeysMode).toBe(true);
    await expect
      .poll(() => readFile(fixture.directory + "/received"), { timeout: 2000 })
      .toEqual(Buffer.from("\x1bOA"));
  } finally {
    release();
    await barrier;
    output?.mockRestore();
    await fixture.close();
  }
}, 10000);

test.skipIf(process.platform !== "linux")(
  "an unknown send retains its actual client and capacity until queued expiry and later input",
  async () => {
    const inputCapacity = 64;
    const requestBytes = inputCapacity / 2;
    const fixture = await receiver({ terminalInputBytes: inputCapacity });
    const { session } = fixture;
    const firstText = "FIRST".padEnd(requestBytes, "1");
    const secondText = "SECOND".padEnd(requestBytes, "2");
    let serverPid: number | undefined;
    let serverStopped = false;
    let clientPid: number | undefined;
    let clientStopped = false;
    let first: Promise<unknown> | undefined;
    try {
      await fixture.ready();
      serverPid = Number(
        (await tmux(session.options.socket, ["display-message", "-p", "#{pid}"])).trim(),
      );
      process.kill(serverPid, "SIGSTOP");
      serverStopped = true;
      const deadline = Date.now() + 1500;
      first = session.input.operation({
        type: "session.send",
        input: { type: "text", text: firstText },
        deadline,
      });
      const expiredFirst = expect(first).rejects.toMatchObject({
        code: "timeout",
        outcome: "unknown",
      });
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
              if (args.includes(session.options.socket) && args.includes("load-buffer"))
                clientPid = Number(id);
            }
            return clientPid !== undefined;
          },
          { timeout: 1000 },
        )
        .toBe(true);
      process.kill(clientPid!, "SIGSTOP");
      clientStopped = true;
      const clientState = async () =>
        (await readFile(`/proc/${clientPid}/stat`, "utf8")).split(") ")[1]![0];
      await expect.poll(clientState, { timeout: 1000 }).toBe("T");
      expect(Date.now()).toBeLessThan(deadline);
      process.kill(serverPid, "SIGCONT");
      serverStopped = false;
      await expiredFirst;
      expect(await clientState()).toBe("T");
      const second = session.input.operation({
        type: "session.send",
        input: { type: "text", text: secondText },
        deadline: Date.now() + 100,
      });
      await expect(
        session.input.operation({
          type: "session.send",
          input: { type: "text", text: "EXCESS" },
          deadline: Date.now() + 2000,
        }),
      ).rejects.toMatchObject({ code: "limit_exceeded" });
      await expect(second).rejects.toMatchObject({ code: "timeout", outcome: "failed" });
      expect(await clientState()).toBe("T");
      expect((await readFile(fixture.directory + "/received")).includes(secondText)).toBe(false);
      process.kill(clientPid!, "SIGCONT");
      clientStopped = false;
      await session.input.operation({
        type: "session.send",
        input: { type: "text", text: "AFTER" },
        deadline: Date.now() + 2000,
      });
      await expect
        .poll(async () => (await readFile(fixture.directory + "/received")).subarray(-5), {
          timeout: 2000,
        })
        .toEqual(Buffer.from("AFTER"));
      expect((await readFile(fixture.directory + "/received")).includes(secondText)).toBe(false);
      expect(session.model.inputState().inputSeq).toBe(3);
    } finally {
      if (serverStopped) process.kill(serverPid!, "SIGCONT");
      if (clientStopped) process.kill(clientPid!, "SIGCONT");
      await first?.catch(() => {});
      await fixture.close();
    }
  },
  10000,
);
