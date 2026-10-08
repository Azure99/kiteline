import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { terminalOutputCost, type RecorderMessage } from "@kiteline/shared/protocol/ipc";
import { shellWords, tmux } from "@kiteline/shared/terminal/node";
import { RecordedSession } from "../src/session.js";

test("slow consumption pauses the producer and automatically drains input and the exit tail", async () => {
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
for (let round = 0; round < 3; round++) {
  while (!existsSync("go-" + round)) await delay(5);
  for (let i = 0; i < 512; i++) {
    write("x".repeat(4094) + "\\r\\n");
    writeFileSync("progress", round + ":" + i);
    if (i % 8 === 0) await delay(1);
  }
  write("ROUND_" + round + "\\r\\n");
}
`,
  );
  const outputs = new Map(
    ["slow", "fast"].map((id) => [id, { credit: 0, data: "", frames: [] as RecorderMessage[] }]),
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
    for (let round = 0; round < 3; round++) {
      stopped = true;
      await writeFile(join(directory, "go-" + round), "");
      await expect.poll(() => slow.data.length).toBeGreaterThan(round * 2 * 1024 * 1024);
      await delay(200);
      const progress = await readFile(join(directory, "progress"), "utf8");
      await delay(200);
      expect(await readFile(join(directory, "progress"), "utf8")).toBe(progress);
      expect(progress).not.toBe(round + ":511");
      session.input.input("slow", Buffer.from("text" + round + "\x03"));
      session.input.paste("slow", "paste" + round);
      stopped = false;
      session.consumed("slow", slow.credit);
      await expect.poll(() => slow.data.includes("ROUND_" + round)).toBe(true);
      await expect.poll(() => fast.data).toBe(slow.data);
    }
    session.input.input("slow", Buffer.from("DONE"));
    for (const output of [slow, fast]) {
      await expect
        .poll(() =>
          output.frames.some(
            (message) => message.type === "frame" && message.frame.type === "ended",
          ),
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
      expect(output.data.match(/x/g)).toHaveLength(4094 * 512 * 3);
    }
    expect(await readFile(join(directory, "input"), "utf8")).toBe(
      "text0\x03paste0text1\x03paste1text2\x03paste2DONE",
    );
  } finally {
    await session.close();
    await tmux(socket, ["kill-server"]);
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
