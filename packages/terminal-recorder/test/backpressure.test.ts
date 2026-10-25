import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { terminalOutputCost, type RecorderMessage } from "@kiteline/shared/protocol/ipc";
import { shellWords, tmux } from "@kiteline/shared/terminal/node";
import { RecordedSession } from "../src/session.js";

test("slow displays recover within their budget or fail without blocking the producer and other displays", async () => {
  const directory = await mkdtemp("/var/tmp/kiteline-backpressure-");
  const socket = join(directory, "tmux.sock");
  const producer = join(directory, "producer.mjs");
  await writeFile(
    producer,
    `import { existsSync, writeFileSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
process.stdin.setRawMode(true);
const write = (text) => {
  const data = Buffer.from(text);
  for (let offset = 0; offset < data.length;) offset += writeSync(1, data, offset, data.length - offset);
};
let input = Buffer.alloc(0);
process.stdin.on("data", data => {
  input = Buffer.concat([input, data]);
  writeFileSync("input", input);
  if (input.includes("DONE")) { write("FINAL_TAIL_23"); process.exit(23); }
});
for (let round = 0; round < 4; round++) {
  while (!existsSync("go-" + round)) await delay(5);
  for (let i = 0; i < 512; i++) {
    write("x".repeat(4094) + "\\r\\n");
    if (i % 8 === 0) await delay(1);
  }
  write("ROUND_" + round + "\\r\\n");
}
`,
  );
  const outputs = new Map(
    ["slow", "fast", "reconnected"].map((id) => [
      id,
      { credit: 0, data: "", frames: [] as RecorderMessage[] },
    ]),
  );
  let stopped = false;
  const session = new RecordedSession(
    {
      type: "create",
      sessionId: "backpressure",
      socket,
      workspacePath: directory,
      shell: "/bin/bash",
      command: "exec " + shellWords([process.execPath, producer]),
      cols: 80,
      rows: 24,
      historyLines: 100,
    },
    { terminalInputBytes: 65536 },
    (message) => {
      if (message.type !== "bytes" && message.type !== "frame") return true;
      const output = outputs.get(message.attachmentId)!;
      if (message.type === "bytes") {
        const bytes = Buffer.from(message.dataBase64, "base64");
        output.data += bytes.toString();
        output.credit += terminalOutputCost(bytes.length);
      } else {
        output.frames.push(message);
        if (message.frame.type !== "error" && message.frame.type !== "input.error")
          output.credit += terminalOutputCost(Buffer.byteLength(JSON.stringify(message.frame)));
      }
      if (message.attachmentId !== "slow" || !stopped)
        queueMicrotask(() => session.consumed(message.attachmentId, output.credit));
      return true;
    },
    () => {},
  );
  const slow = outputs.get("slow")!;
  const fast = outputs.get("fast")!;
  try {
    await session.start();
    await session.attach("slow", "retained", false);
    await session.attach("fast", "retained", false);
    stopped = true;
    await writeFile(join(directory, "go-0"), "");
    await expect.poll(() => fast.data.includes("ROUND_0"), { timeout: 10000 }).toBe(true);
    expect(slow.data.includes("ROUND_0")).toBe(false);
    session.input.input("fast", Buffer.from("text\x03"));
    session.input.paste("fast", "paste");
    await expect.poll(() => readFile(join(directory, "input"), "utf8")).toBe("text\x03paste");
    stopped = false;
    session.consumed("slow", slow.credit);
    await expect.poll(() => slow.data, { timeout: 10000 }).toBe(fast.data);
    expect(
      slow.frames.some((message) => message.type === "frame" && message.frame.type === "error"),
    ).toBe(false);

    stopped = true;
    for (let round = 1; round < 4; round++) {
      await writeFile(join(directory, "go-" + round), "");
      await expect.poll(() => fast.data.includes("ROUND_" + round), { timeout: 10000 }).toBe(true);
    }
    expect(slow.frames.at(-1)).toMatchObject({
      frame: { type: "error", code: "limit_exceeded" },
    });
    const disconnectedData = slow.data;
    await session.attach("reconnected", "retained", false);
    await expect.poll(() => outputs.get("reconnected")!.data.includes("ROUND_3")).toBe(true);
    session.input.input("fast", Buffer.from("DONE"));
    for (const output of [fast, outputs.get("reconnected")!]) {
      await expect
        .poll(
          () =>
            output.frames.some(
              (message) => message.type === "frame" && message.frame.type === "ended",
            ),
          // tmux checks life subscriptions once per second.
          { timeout: 5000 },
        )
        .toBe(true);
      expect(
        output.frames.filter(
          (message) =>
            message.type === "frame" && ["error", "input.error"].includes(message.frame.type),
        ),
      ).toEqual([]);
      expect(output.frames.at(-1)).toMatchObject({ frame: { type: "ended", exitCode: 23 } });
      expect(output.data.endsWith("FINAL_TAIL_23")).toBe(true);
    }
    expect(fast.data.match(/x/g)).toHaveLength(4094 * 512 * 4);
    expect(slow.data).toBe(disconnectedData);
    expect(await readFile(join(directory, "input"), "utf8")).toBe("text\x03pasteDONE");
  } finally {
    await session.close();
    await tmux(socket, ["kill-server"]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
