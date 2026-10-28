import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import type { CreateTerminal } from "../protocol/ipc.js";
import { spawnJob } from "../windows/job.js";
import { BytePrefix } from "../node/buffers.js";
import {
  msysPath,
  sessionFiles,
  terminalPreset,
  tmux,
  tmuxBinary,
  tmuxEnvironment,
  tmuxServerMissing,
} from "./node.js";

export interface PaneLaunch {
  shell: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export function paneCommand(socket: string) {
  return [
    msysPath(process.execPath),
    msysPath(resolve(import.meta.dirname, "pane.js")),
    msysPath(sessionFiles(dirname(socket)).paneLaunch),
  ];
}

export async function startTerminalServer(options: CreateTerminal, timeout: number) {
  const { config, paneLaunch } = sessionFiles(dirname(options.socket));
  const launch: PaneLaunch = {
    shell: options.shell,
    args: options.command === undefined ? ["-NoLogo"] : ["-NoLogo", "-Command", options.command],
    environment: { ...process.env },
  };
  await writeFile(config, terminalPreset(options), { mode: 0o600 });
  await writeFile(paneLaunch, JSON.stringify(launch), { mode: 0o600 });
  const server = await spawnJob(
    tmuxBinary,
    ["-D", "-S", msysPath(options.socket), "-f", msysPath(config), "-u"],
    { cwd: options.workspacePath, env: tmuxEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout!.resume();
  const stderr = new BytePrefix(8192);
  server.stderr!.on("data", (data: Buffer) => {
    stderr.append(data);
  });
  const drained = Promise.all([
    finished(server.stdout!, { writable: false, cleanup: true }),
    finished(server.stderr!, { writable: false, cleanup: true }),
  ]);
  void drained.catch(() => {});
  let exited = false;
  void server.exited.then(() => (exited = true));
  try {
    const signal = AbortSignal.timeout(timeout);
    while (true) {
      signal.throwIfAborted();
      if (exited) throw new Error(stderr.text().trim() || "Terminal server exited during startup");
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
        if (!tmuxServerMissing(error)) throw error;
      }
      await delay(20, undefined, { signal });
    }
    return { job: server, drained };
  } catch (error) {
    await server.stop();
    await drained;
    throw error;
  }
}
