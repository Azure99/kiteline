import { spawn, spawnSync } from "node:child_process";

const build = spawnSync("pnpm", ["exec", "tsc", "-b"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const launch = (command, args) => spawn(command, args, { stdio: "inherit", detached: true });
const children = [
  launch("pnpm", ["exec", "tsc", "-b", "--watch"]),
  launch(process.execPath, ["--watch", "server/dist/main.js"]),
  launch("pnpm", ["--filter", "@kiteline/web", "dev"]),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
for (const child of children)
  child.on("exit", (code) => {
    if (stopping) return;
    process.exitCode = code ?? 1;
    stop();
  });
