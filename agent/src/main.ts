import { appVersion } from "@kiteline/shared/protocol";
import { agentConfig, privateDirectory, readIdentity } from "./config.js";
import { Agent } from "./agent.js";
import { bindCli } from "./cli/bind.js";
import { attachCli, terminalCli } from "./cli/terminal.js";
import { scheduleCli } from "./cli/tasks.js";
import { doctorCli } from "./cli/doctor.js";
import { installCli } from "./install/commands.js";
import { checkPrerequisites } from "./prerequisites.js";
import { lockAgentRuntime, lockAgentState } from "./state-lock.js";

const usage =
  "Usage: kiteline-agent install --user USER | upgrade --archive RELEASE.tar.gz | uninstall | check | bind --server HTTP_OR_HTTPS_ORIGIN [--if-unbound] | run | doctor | attach SESSION_ID [--run-dir DIR] | terminal | workspace | schedule";

async function runAgent() {
  let stopping = false;
  let agent: Agent | undefined;
  let releaseState: (() => Promise<void>) | undefined;
  let releaseRuntime: (() => Promise<void>) | undefined;
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
      await releaseRuntime?.();
      await releaseState?.();
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
    releaseState = await lockAgentState(config.dataDir);
    if (stopping) return;
    await privateDirectory(config.runDir);
    if (stopping) return;
    if (process.platform !== "win32") {
      releaseRuntime = await lockAgentRuntime(config.runDir);
      if (stopping) return;
    }
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
    await attachCli(process.argv.slice(3));
    return;
  }
  if (command === "bind") {
    await bindCli(process.argv.slice(3));
    return;
  }
  if (command === "workspace" || command === "terminal") {
    await terminalCli(await agentConfig(), process.argv.slice(2));
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
    console.log(`${usage}\nScheduled Tasks: kiteline-agent schedule --help`);
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
  throw new Error(usage);
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode ||= 1;
});
