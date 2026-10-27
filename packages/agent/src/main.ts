import { appVersion, asError, OperationError } from "@kiteline/shared/protocol";
import { agentConfig, privateDirectory, readIdentity } from "./config.js";
import { Agent } from "./agent.js";
import { bindCli } from "./cli/bind.js";
import { terminalCli } from "./cli/terminal.js";
import { scheduleCli } from "./cli/tasks.js";
import { doctorCli } from "./cli/doctor.js";
import { installCli } from "./install/commands.js";
import { checkPrerequisites, checkWindowsShell } from "./prerequisites.js";
import { lockAgentRuntime, lockAgentState } from "./state-lock.js";

const commands = `check | bind --server HTTP_OR_HTTPS_ORIGIN [--if-unbound] | run | doctor | terminal | workspace | schedule`;
const usage =
  process.platform === "win32"
    ? `Usage: kiteline-agent ${commands}
Windows maintenance (PowerShell):
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File NEW_PACKAGE\\bin\\kiteline-agent.ps1 install --user USER
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File NEW_PACKAGE\\bin\\kiteline-agent.ps1 upgrade --archive RELEASE.zip
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'kiteline-agent/kiteline-agent.ps1') uninstall`
    : `Usage: kiteline-agent install --user USER | upgrade --archive RELEASE.tar.gz | uninstall | ${commands}`;

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
    if (process.platform === "win32") {
      await checkWindowsShell(config.shell);
      if (stopping) return;
    }
    await privateDirectory(config.dataDir);
    if (stopping) return;
    releaseState = await lockAgentState(config.dataDir);
    if (stopping) return;
    await privateDirectory(config.runDir);
    if (stopping) return;
    releaseRuntime = await lockAgentRuntime(config.runDir);
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
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "bind") {
    await bindCli(args.slice(1));
    return;
  }
  if (command === "workspace" || command === "terminal") {
    try {
      await terminalCli(await agentConfig(), args);
    } catch (error) {
      const detail = asError(error);
      const result =
        error instanceof OperationError
          ? (error.result as { sessionId?: string } | undefined)
          : undefined;
      console.error(
        `${detail.code}: ${detail.message}${result?.sessionId ? ` (sessionId=${result.sessionId})` : ""}`,
      );
      process.exitCode = error instanceof OperationError && error.outcome === "unknown" ? 3 : 1;
    }
    return;
  }
  if (command === "--version" && args.length === 1) {
    console.log(appVersion);
    return;
  }
  if (command === "schedule") {
    await scheduleCli(args.slice(1));
    return;
  }
  if (args.length === 0 || (args.length === 1 && (command === "--help" || command === "-h"))) {
    console.log(`${usage}\nScheduled Tasks: kiteline-agent schedule --help`);
    return;
  }
  if (command === "install" || command === "upgrade" || command === "uninstall") {
    await installCli(command, args.slice(1));
    return;
  }
  if (args.length === 1) {
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
  }
  console.error(usage);
  process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode ||= 1;
});
