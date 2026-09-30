import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import type { CreateTerminal } from "../protocol/ipc.js";
import { spawnJob } from "../windows/job.js";
import { msysPath, terminalPreset, tmux, tmuxBinary, tmuxEnvironment } from "./native.js";

export interface PaneLaunch {
  shell: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  socket: string;
}
export function paneCommand(socket: string) {
  return [
    msysPath(process.execPath),
    msysPath(resolve(import.meta.dirname, "pane.js")),
    msysPath(join(dirname(socket), "pane.json")),
  ];
}

export async function startTerminalServer(options: CreateTerminal, timeout: number) {
  const directory = dirname(options.socket);
  const config = join(directory, "tmux.conf");
  const launch: PaneLaunch = {
    shell: options.shell,
    args: options.command === undefined ? ["-NoLogo"] : ["-NoLogo", "-Command", options.command],
    environment: { ...process.env },
    socket: options.socket,
  };
  await writeFile(config, terminalPreset(options), { mode: 0o600 });
  await writeFile(join(directory, "pane.json"), JSON.stringify(launch), { mode: 0o600 });
  const server = await spawnJob(
    tmuxBinary,
    ["-D", "-S", msysPath(options.socket), "-f", msysPath(config), "-u"],
    { cwd: options.workspacePath, env: tmuxEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout!.resume();
  let stderr = "";
  server.stderr!.on("data", (data: Buffer) => {
    if (stderr.length < 8192) stderr += data.toString();
  });
  const drained = Promise.all([
    finished(server.stdout!, { writable: false, cleanup: true }),
    finished(server.stderr!, { writable: false, cleanup: true }),
  ]);
  void drained.catch(() => {});
  let exited = false;
  void server.exited.then(
    () => (exited = true),
    () => (exited = true),
  );
  try {
    const signal = AbortSignal.timeout(timeout);
    while (true) {
      signal.throwIfAborted();
      if (exited) throw new Error(stderr.trim() || "Terminal server exited during startup");
      try {
        // The first client loads the preset; -D keeps an empty server alive.
        if (
          (
            await tmux(
              options.socket,
              ["show-options", "-s", "-v", "exit-empty"],
              undefined,
              signal,
            )
          ).trim() === "off"
        )
          break;
      } catch (error) {
        signal.throwIfAborted();
        if (
          !(error instanceof Error) ||
          !/No such file or directory|Connection refused|no server running/.test(error.message)
        )
          throw error;
      }
      await delay(20, undefined, { signal });
    }
    return { job: server, drained };
  } catch (error) {
    try {
      server.terminate();
    } finally {
      await server.empty;
      await drained;
    }
    throw error;
  }
}
