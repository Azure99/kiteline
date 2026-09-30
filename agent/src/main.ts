import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AppError, appVersion, record, string } from "@kiteline/shared/protocol";
import {
  agentConfig,
  agentPaths,
  atomicJson,
  defaultAgentLimits,
  privateDirectory,
  readIdentity,
} from "./config.js";
import { Agent } from "./control.js";
import { attachTerminal, terminalCli } from "./terminal-cli.js";
import { scheduleCli } from "./schedule-cli.js";
import { doctorCli } from "./doctor.js";
import { installCli } from "./install.js";
import { checkPrerequisites } from "./prerequisites.js";
import { fetchServerJson } from "./network.js";
import { lockAgentState } from "./state-lock.js";

async function input(prompt: string) {
  if (!process.stdin.isTTY) {
    let result = "";
    for await (const part of process.stdin) {
      result += part.toString();
      if (result.length > 4096) throw new Error("Input is too long");
    }
    return result.trim();
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}
async function runAgent() {
  let stopping = false;
  let agent: Agent | undefined;
  let release: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const signals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const close = () => {
    if (closing) return closing;
    stopping = true;
    const cleanup = agent?.close();
    return (closing = (async () => {
      await initialization.catch(() => {});
      await cleanup;
      // A failed cleanup must not hand live state to a second agent.
      await release?.();
      for (const signal of signals) process.off(signal, stop);
    })());
  };
  const stop = () => {
    void close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  for (const signal of signals) process.on(signal, stop);
  const initialization = (async () => {
    const config = await agentConfig();
    if (stopping) return;
    await privateDirectory(config.dataDir);
    if (stopping) return;
    release = await lockAgentState(config.dataDir);
    if (stopping) return;
    const identity = await readIdentity(config);
    if (stopping) return;
    agent = new Agent(config, identity);
    await agent.start();
    if (!stopping) console.log(`Agent ${identity.deviceId} connecting to ${identity.server}`);
  })();
  try {
    await initialization;
    if (stopping) await close();
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Agent startup and cleanup failed", {
        cause: closeError,
      });
    }
    throw error;
  }
}
async function main() {
  const command = process.argv[2];
  if (command === "attach") {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(3),
      allowPositionals: true,
      options: { "run-dir": { type: "string" } },
    });
    if (positionals.length !== 1)
      throw new Error("Usage: kiteline-agent attach SESSION_ID [--run-dir DIR]");
    const override =
      values["run-dir"] === undefined ? undefined : string(values["run-dir"], "run-dir");
    const { runDir } = await agentPaths(override);
    await attachTerminal(
      { runDir, limits: defaultAgentLimits },
      string(positionals[0], "session id"),
    );
    return;
  }
  if (process.argv.includes("--version")) {
    console.log(appVersion);
    return;
  }
  if (command === "schedule") {
    await scheduleCli(process.argv.slice(3));
    return;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(
      "Usage: kiteline-agent install | upgrade | uninstall | check | bind | run | doctor | attach | terminal | workspace | schedule\nAttach: kiteline-agent attach SESSION_ID [--run-dir DIR]\nScheduled Tasks: kiteline-agent schedule --help",
    );
    return;
  }
  if (command === "install" || command === "upgrade" || command === "uninstall") {
    await installCli(command, process.argv.slice(3));
    return;
  }
  if (command === "check") {
    await checkPrerequisites();
    return;
  }
  if (command === "run") {
    await runAgent();
    return;
  }
  if (command === "doctor") {
    await doctorCli();
    return;
  }
  if (command === "workspace" || command === "terminal") {
    await terminalCli(await agentConfig(), process.argv.slice(2));
    return;
  }
  if (command !== "bind")
    throw new Error(
      "Usage: kiteline-agent install --user USER | upgrade --archive RELEASE.tar.gz | uninstall | check | bind --server HTTP_OR_HTTPS_ORIGIN [--if-unbound] | run | doctor | attach SESSION_ID [--run-dir DIR] | terminal | workspace | schedule",
    );
  const config = await agentConfig();
  let releaseState: (() => Promise<void>) | undefined;
  try {
    await privateDirectory(config.dataDir);
    releaseState = await lockAgentState(config.dataDir);
    const index = process.argv.indexOf("--server");
    const server = new URL(string(index < 0 ? undefined : process.argv[index + 1], "server"));
    if (server.protocol !== "http:" && server.protocol !== "https:")
      throw new AppError("invalid_argument", "server must use HTTP or HTTPS");
    if (process.argv.includes("--if-unbound")) {
      const exists = await lstat(resolve(config.dataDir, "connection.json")).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new Error(
          "This installation is already bound; the existing device identity is retained. Use kiteline-agent run. To bind again, stop the existing instance first, then explicitly run kiteline-agent bind.",
        );
    }
    const code = await input("Binding code: ");
    let value: Record<string, unknown>;
    try {
      const response = await fetchServerJson(new URL("/api/agent/bind", server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: hostname() }),
        signal: AbortSignal.timeout(config.limits.channelPairTimeout),
      });
      value = record(response.body);
      if (!response.ok)
        throw new AppError(String(record(value.error).code), String(record(value.error).message));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new Error(
        "Binding result is unknown. Sign in to the web app and check this binding. If the code was consumed but no credentials were saved locally, delete the device and bind again with a new code.",
        { cause: error },
      );
    }
    const identity = {
      deviceId: string(value.deviceId),
      deviceToken: string(value.deviceToken),
      server: server.origin,
    };
    try {
      await atomicJson(resolve(config.dataDir, "connection.json"), identity);
    } catch (error) {
      throw new Error(
        `Device ${identity.deviceId} was registered but its credentials were not saved; delete it in the web app and bind again.`,
        {
          cause: error,
        },
      );
    }
    console.log(`Device bound: ${identity.deviceId}`);
  } finally {
    await releaseState?.();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode ||= 1;
});
