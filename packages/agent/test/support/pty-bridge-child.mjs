import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { Socket } from "node:net";
import { createInterface } from "node:readline";

// fd 3/4 are independent of the PTY, so the test can control a child whose
// terminal input is incomplete or blocked without sending another input frame.
const commands = createInterface({ input: new Socket({ fd: 3, readable: true, writable: false }) });
const mode = process.argv[2];
const received = [];

function report(message) {
  writeSync(4, JSON.stringify(message) + "\n");
}

function readTerminal() {
  process.stdin.on("data", (data) => {
    received.push(data);
    process.stdout.write(data);
    report({ event: "input" });
  });
}

const raw = spawnSync("stty", ["raw", "-echo"], { stdio: ["inherit", "ignore", "inherit"] });
if (raw.error) throw raw.error;
if (raw.status !== 0) throw new Error(`stty raw -echo exited ${raw.status}`);
if (mode === "ignore-hangup") {
  process.on("SIGHUP", () => report({ event: "hangup" }));
}
if (mode !== "hold-input") readTerminal();

commands.on("line", (command) => {
  if (command.startsWith("marker:")) {
    process.stdout.write(`<${command.slice("marker:".length)}>`);
  } else if (command === "read") {
    readTerminal();
  } else if (command === "snapshot") {
    const [cols, rows] = process.stdout.getWindowSize();
    report({ event: "snapshot", input: Buffer.concat(received).toString("base64"), cols, rows });
  } else if (command === "finish") {
    const tail = Buffer.from("natural-exit-tail\0\r\n".repeat(8192));
    process.stdout.write(tail, () => process.exit(23));
  } else if (command === "exit") {
    process.exit(0);
  } else {
    throw new Error(`Unknown PTY test command: ${command}`);
  }
});

report({ event: "ready", pid: process.pid });
