import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { PaneLaunch } from "./windows.js";
import { msysPath, tmuxBinary, tmuxEnvironment } from "./native.js";

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
    const published = spawnSync(
      tmuxBinary,
      [
        "-N",
        "-S",
        msysPath(launch.socket),
        "set-option",
        "-p",
        "-t",
        pane,
        "@kiteline-exit-dword",
        String(code),
      ],
      { env: tmuxEnvironment(), stdio: "inherit", timeout: 3000 },
    );
    if (published.error || published.status !== 0) {
      console.error(published.error?.message ?? "Could not publish the terminal exit code");
      process.exitCode = 1;
    }
  });
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
