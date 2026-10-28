import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionFiles } from "./node.js";
import type { PaneLaunch } from "./windows.js";

async function main() {
  const launch = JSON.parse(await readFile(process.argv[2]!, "utf8")) as PaneLaunch;
  const pane = process.env.TMUX_PANE;
  if (!pane) throw new Error("Terminal pane identity is missing");
  process.on("SIGINT", () => {});
  process.on("SIGBREAK", () => {});
  const environment = {
    ...launch.environment,
    TERM: process.env.TERM,
    TMUX: process.env.TMUX,
    TMUX_PANE: pane,
  };
  const child = spawn(launch.shell, launch.args, { stdio: "inherit", env: environment });
  let failed = false;
  child.on("error", (error) => {
    failed = true;
    console.error(error.message);
  });
  child.on("close", (code, signal) => {
    if (
      failed ||
      signal ||
      code === null ||
      !Number.isInteger(code) ||
      code < 0 ||
      code > 0xffffffff
    ) {
      process.exitCode = 1;
      return;
    }
    try {
      const status = Buffer.allocUnsafe(4);
      status.writeUInt32LE(code);
      writeFileSync(sessionFiles(dirname(process.argv[2]!)).paneExit, status, { mode: 0o600 });
    } catch (error) {
      console.error("Could not publish the terminal exit code:", error);
      process.exitCode = 1;
    }
  });
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
