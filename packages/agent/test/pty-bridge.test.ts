import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { limits } from "@kiteline/shared/protocol";
import { ptyBridgeBinary } from "@kiteline/shared/terminal/node";

type Report =
  | { event: "ready"; pid: number }
  | { event: "input" }
  | { event: "snapshot"; input: string; cols: number; rows: number }
  | { event: "hangup" };

const cleanups: (() => Promise<void>)[] = [];
const polling = { timeout: 5000, interval: 10 };
const childScript = fileURLToPath(new URL("./support/pty-bridge-child.mjs", import.meta.url));
const frameHeaderBytes = 5;
const frameLengthOffset = 1;
const resizePayloadBytes = 4;
const resizeColsOffset = 0;
const resizeRowsOffset = 2;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function frameHeader(type: string, payloadBytes: number) {
  const header = Buffer.alloc(frameHeaderBytes);
  header.write(type);
  header.writeUInt32BE(payloadBytes, frameLengthOffset);
  return header;
}

function frame(type: string, payload: Buffer) {
  return Buffer.concat([frameHeader(type, payload.length), payload]);
}

async function startBridge(mode = "echo") {
  const child = spawn(
    ptyBridgeBinary,
    [
      "80",
      "24",
      String(limits.dataChunkBytes),
      String(limits.terminalPendingBytes),
      process.execPath,
      childScript,
      mode,
    ],
    { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
  );
  const output: Buffer[] = [];
  const diagnostic: Buffer[] = [];
  const reports: Report[] = [];
  child.stdout!.on("data", (data: Buffer) => output.push(data));
  child.stderr!.on("data", (data: Buffer) => diagnostic.push(data));
  const reportLines = createInterface({ input: child.stdio[4] as Readable });
  reportLines.on("line", (line) => reports.push(JSON.parse(line) as Report));
  const commands = child.stdio[3] as Writable;
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.stdin!.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    try {
      await expect
        .poll(() => child.exitCode !== null || child.signalCode !== null, polling)
        .toBe(true);
    } catch (error) {
      const ready = reports.find((report) => report.event === "ready");
      if (ready) process.kill(ready.pid, "SIGKILL");
      child.kill("SIGKILL");
      throw error;
    } finally {
      await closed;
    }
  });
  await expect
    .poll(() => reports.find((report) => report.event === "ready"), polling)
    .toBeDefined();
  const clientPid = reports.find((report) => report.event === "ready")!.pid;
  return {
    child,
    clientPid,
    closed,
    reports,
    output: () => Buffer.concat(output),
    diagnostic: () => Buffer.concat(diagnostic).toString(),
    command: (command: string) => commands.write(command + "\n"),
    send: (data: Buffer) =>
      new Promise<void>((resolve, reject) => {
        child.stdin!.write(data, (error) => (error ? reject(error) : resolve()));
      }),
  };
}

test("PTY frames accept fragmented headers and payloads, preserve bytes, and resize in order", async () => {
  const bridge = await startBridge();
  const input = Buffer.concat([Buffer.from("中文\r\n"), Buffer.from([0, 3, 127, 128, 255])]);
  const inputHeader = frameHeader("I", input.length);
  const expected: Buffer[] = [];
  async function fragment(data: Buffer, marker: string) {
    await bridge.send(data);
    bridge.command(`marker:${marker}`);
    expected.push(Buffer.from(`<${marker}>`));
    await expect.poll(bridge.output, polling).toEqual(Buffer.concat(expected));
  }
  await fragment(inputHeader.subarray(0, 2), "input-header-part");
  await fragment(inputHeader.subarray(2), "input-header-complete");
  await fragment(input.subarray(0, 3), "input-payload-part");
  await bridge.send(input.subarray(3));
  expected.push(input);
  await expect.poll(bridge.output, polling).toEqual(Buffer.concat(expected));

  const dimensions = Buffer.alloc(resizePayloadBytes);
  dimensions.writeUInt16BE(113, resizeColsOffset);
  dimensions.writeUInt16BE(37, resizeRowsOffset);
  const resizeHeader = frameHeader("R", dimensions.length);
  await fragment(resizeHeader.subarray(0, 3), "resize-header-part");
  await fragment(
    Buffer.concat([resizeHeader.subarray(3), dimensions.subarray(0, 1)]),
    "resize-payload-part",
  );
  const adjacent = Buffer.from("adjacent-输入");
  const last = Buffer.from([1, 2, 0, 255]);
  await bridge.send(
    Buffer.concat([dimensions.subarray(1), frame("I", adjacent), frame("I", last)]),
  );
  expected.push(adjacent, last);
  await expect.poll(bridge.output, polling).toEqual(Buffer.concat(expected));
  bridge.command("snapshot");
  await expect
    .poll(() => bridge.reports.find((report) => report.event === "snapshot"), polling)
    .toEqual({
      event: "snapshot",
      input: Buffer.concat([input, adjacent, last]).toString("base64"),
      cols: 113,
      rows: 37,
    });
  bridge.command("exit");
  expect(await bridge.closed).toEqual({ code: 0, signal: null });
  expect(bridge.diagnostic()).toBe("");
}, 15000);

test("PTY input backpressure permits reverse output and natural exit drains the complete tail", async () => {
  const bridge = await startBridge("hold-input");
  const input = Buffer.alloc(limits.dataChunkBytes);
  for (let index = 0; index < input.length; index++) input[index] = index % 256;
  await bridge.send(frame("I", input));
  bridge.command("marker:before-read");
  const marker = Buffer.from("<before-read>");
  await expect.poll(bridge.output, polling).toEqual(marker);
  expect(bridge.reports.some((report) => report.event === "input")).toBe(false);

  bridge.command("read");
  await expect.poll(() => bridge.output().length, polling).toBe(marker.length + input.length);
  expect(bridge.output()).toEqual(Buffer.concat([marker, input]));
  bridge.command("snapshot");
  await expect
    .poll(() => bridge.reports.find((report) => report.event === "snapshot"), polling)
    .toEqual({ event: "snapshot", input: input.toString("base64"), cols: 80, rows: 24 });
  bridge.command("finish");
  expect(await bridge.closed).toEqual({ code: 23, signal: null });
  const tail = Buffer.from("natural-exit-tail\0\r\n".repeat(8192));
  expect(bridge.output()).toEqual(Buffer.concat([marker, input, tail]));
  expect(bridge.diagnostic()).toBe("");
}, 15000);

test("PTY rejects invalid frames and partial EOF, and SIGTERM ends its client", async () => {
  for (const invalid of [
    frame("X", Buffer.from([1])),
    frame("R", Buffer.alloc(resizePayloadBytes - 1)),
  ]) {
    const bridge = await startBridge();
    await bridge.send(invalid);
    expect(await bridge.closed).toEqual({ code: 1, signal: null });
    expect(bridge.diagnostic()).toBe("Invalid PTY input frame\n");
    expect(() => process.kill(bridge.clientPid, 0)).toThrow(/ESRCH/);
  }
  const unfinishedInput = Buffer.from("unfinished");
  const inputHeader = frameHeader("I", unfinishedInput.length);
  for (const partial of [
    inputHeader.subarray(0, 2),
    Buffer.concat([inputHeader, unfinishedInput.subarray(0, 3)]),
  ]) {
    const bridge = await startBridge();
    bridge.child.stdin!.end(partial);
    expect(await bridge.closed).toEqual({ code: 1, signal: null });
    expect(bridge.diagnostic()).toBe("PTY input closed\n");
    expect(() => process.kill(bridge.clientPid, 0)).toThrow(/ESRCH/);
  }
  const bridge = await startBridge("ignore-hangup");
  bridge.child.kill("SIGTERM");
  expect(await bridge.closed).toEqual({ code: 1, signal: null });
  expect(bridge.diagnostic()).toBe("PTY bridge interrupted\n");
  expect(bridge.reports).toContainEqual({ event: "hangup" });
  expect(() => process.kill(bridge.clientPid, 0)).toThrow(/ESRCH/);
}, 15000);
