import { existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = process.argv[2];
const { rounds, linesPerRound, charactersPerLine, yieldEveryLines } = JSON.parse(process.argv[3]);
const gatePollIntervalMs = 5;
const yieldDelayMs = 1;

process.stdin.setRawMode(true);
function write(text) {
  const data = Buffer.from(text);
  for (let offset = 0; offset < data.length; ) {
    offset += writeSync(1, data, offset, data.length - offset);
  }
}

let input = Buffer.alloc(0);
process.stdin.on("data", (data) => {
  input = Buffer.concat([input, data]);
  writeFileSync(join(directory, "input"), input);
  if (input.includes("DONE")) {
    write("FINAL_TAIL_23");
    process.exit(23);
  }
});

for (let round = 0; round < rounds; round++) {
  while (!existsSync(join(directory, "go-" + round))) await delay(gatePollIntervalMs);
  for (let line = 0; line < linesPerRound; line++) {
    write("x".repeat(charactersPerLine) + "\r\n");
    if (line % yieldEveryLines === 0) await delay(yieldDelayMs);
  }
  write("ROUND_" + round + "\r\n");
}
