import { homedir, userInfo } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AppError, integer, record, string } from "@kiteline/shared/protocol";
import { installedPaths } from "./installation.js";

export interface AgentConfig {
  dataDir: string;
  runDir: string;
  shell: string;
  limits: typeof defaultAgentLimits;
}
export const defaultAgentLimits = {
  editorBytes: 2 * 1024 * 1024,
  transferBytes: 1024 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
  imagePixels: 20_000_000,
  transfersPerDevice: 4,
  fileOperationTimeout: 30 * 60_000,
  searchTimeout: 10_000,
  gitWriteTimeout: 10 * 60_000,
  channelIdleTimeout: 120_000,
  rpcTimeout: 30_000,
  channelPairTimeout: 30_000,
  terminalInputBytes: 256 * 1024,
  terminalSessionsPerDevice: 32,
  terminalStallTimeout: 10_000,
  channelsPerDevice: 128,
  watchDirectories: 8192,
};
export interface Identity {
  deviceId: string;
  deviceToken: string;
  server: string;
}
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function agentPaths() {
  const installed = await installedPaths();
  const dataDir = resolve(
    process.env.KITELINE_AGENT_HOME ??
      installed?.dataDir ??
      resolve(homedir(), ".local/share/kiteline-agent"),
  );
  const runDir = resolve(
    process.env.KITELINE_AGENT_RUN_DIR ?? installed?.runDir ?? resolve(dataDir, "run"),
  );
  return { dataDir, runDir };
}
export async function agentConfig(): Promise<AgentConfig> {
  const { dataDir, runDir } = await agentPaths();
  let input: Record<string, unknown> = {};
  try {
    input = record(await readJson(resolve(dataDir, "config.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const settings = record(input.limits ?? {});
  const defaults = { ...defaultAgentLimits };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[])
    if (settings[key] !== undefined)
      defaults[key] = integer(settings[key], key, 1, Number.MAX_SAFE_INTEGER);
  const shell =
    input.shell === undefined ? userInfo().shell || "/bin/sh" : string(input.shell, "shell");
  if (!isAbsolute(shell)) throw new AppError("invalid_argument", "Shell must be an absolute path");
  return { dataDir, runDir, shell, limits: defaults };
}
export async function readIdentity(config: AgentConfig): Promise<Identity> {
  let value: Record<string, unknown>;
  try {
    value = record(await readJson(resolve(config.dataDir, "connection.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new AppError("not_found", "Device is not bound; run kiteline-agent bind");
    throw error;
  }
  const server = new URL(string(value.server, "server"));
  if (server.protocol !== "https:") throw new AppError("invalid_argument", "server must use HTTPS");
  return {
    server: server.origin,
    deviceId: string(value.deviceId),
    deviceToken: string(value.deviceToken),
  };
}
