import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { appVersion, terminalProfile, type Session } from "@kiteline/shared/protocol";
import { windowsNative } from "@kiteline/shared/windows/native";
import { agentConfig, agentPaths, defaultAgentLimits, type AgentConfig } from "./config.js";
import { localRequest } from "./local.js";
import { packageDirectory } from "./installation.js";
import { checkComponents, checkEnvironment } from "./prerequisites.js";
import type { ScheduledTasks } from "./tasks/index.js";
import { toolCommand, windowsExecutable } from "./tool-checks.js";

interface Item {
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
}
export interface DoctorReport {
  runtime: boolean;
  items: Item[];
}
interface Runtime {
  server: string;
  connected: boolean;
  serverVersion?: string;
  connectionError?: string;
  revision: number;
  shell: string;
  recorderPid?: number;
  sessions: Session[];
  schedules: ReturnType<ScheduledTasks["status"]>;
}
export async function diagnose(
  config: Pick<AgentConfig, "dataDir" | "runDir">,
  signal: AbortSignal,
  runtime?: Runtime,
): Promise<DoctorReport> {
  const items: Item[] = [];
  const add = (name: string, detail: string, status: Item["status"] = "ok") =>
    items.push({ name, detail, status });
  async function check(name: string, action: () => Promise<string>) {
    signal.throwIfAborted();
    try {
      add(name, await action());
    } catch (error) {
      signal.throwIfAborted();
      add(name, error instanceof Error ? error.message.slice(0, 4096) : String(error), "error");
    }
  }
  const windows = process.platform === "win32";
  const macos = process.platform === "darwin";
  const command = (file: string, args: string[], env = process.env) =>
    toolCommand(file, args, { env, signal });
  add(
    "Configuration",
    `data=${config.dataDir}; run=${config.runDir}; metadata=${join(config.dataDir, "agent.json")}; schedules=${join(config.dataDir, "tasks")}`,
  );
  add("Node", `${process.execPath}; ${process.version} ${process.arch}; agent=${appVersion}`);
  const native = join(packageDirectory, "dist/native");
  let nativeLinkage: string | undefined;
  await check("Native build", async () => {
    const identity = JSON.parse(await readFile(join(native, "identity.json"), "utf8"));
    nativeLinkage = identity.linkage;
    return `tmux=${identity.tmux}; linkage=${nativeLinkage}`;
  });
  await check("Recorder entry", async () => {
    await access(join(packageDirectory, "terminal-recorder/dist/main.js"), constants.R_OK);
    return `profile=${terminalProfile}`;
  });
  if (!nativeLinkage)
    add("Native linkage", "Unknown; shared library requirements could not be verified", "warn");
  else if (!windows && !macos)
    for (const name of ["tmux", "rename-noreplace"]) {
      await check(`${name} shared libraries`, async () => {
        if (nativeLinkage === "static-musl")
          return "Static musl; no host dynamic libraries required";
        const result = await command("ldd", [join(native, "bin", name)]);
        if (result.includes("not found")) throw new Error(result);
        return result;
      });
    }
  await checkComponents(check, command);
  if (!runtime) {
    add(
      "Runtime environment",
      "Runtime environment has not been checked; only the current installation and configuration were checked",
      "warn",
    );
    return { runtime: false, items };
  }
  const identity = windows ? windowsNative().identity() : undefined;
  add(
    "Agent",
    `version=${appVersion}; pid=${process.pid}; ${identity ? `SID=${identity.sid}; Session=${identity.sessionId}; profile=${identity.home}` : `uid=${process.getuid?.()}`}; cwd=${process.cwd()}; metadata revision=${runtime.revision}`,
  );
  add(
    "Environment",
    `HOME=${process.env.HOME ?? ""}\n${windows ? `USERPROFILE=${process.env.USERPROFILE ?? ""}\n` : ""}PATH=${process.env.PATH ?? ""}`,
  );
  add(
    "server",
    runtime.server +
      (runtime.connected ? " connected" : " disconnected") +
      (runtime.serverVersion ? `; last server version=${runtime.serverVersion}` : "") +
      (runtime.connectionError ? `; ${runtime.connectionError}` : ""),
    runtime.connected ? "ok" : "warn",
  );
  add(
    "Recorder",
    runtime.recorderPid ? `pid=${runtime.recorderPid}` : "Not running",
    runtime.sessions.length && !runtime.recorderPid ? "warn" : "ok",
  );
  const schedules = runtime.schedules;
  add(
    "Scheduled Tasks",
    `ready=${schedules.ready}; tasks=${schedules.tasks}; active=${schedules.active}; needs_review=${schedules.needsReview}${schedules.storageError ? `; ${schedules.storageError}` : ""}`,
    schedules.storageError ? "error" : !schedules.ready || schedules.needsReview ? "warn" : "ok",
  );
  for (const session of runtime.sessions)
    add(
      `Terminal ${session.id}`,
      `${session.state}; recording=${session.webStatus}${session.webReason ? `; ${session.webReason}` : ""}`,
      session.webStatus === "unavailable" ? "warn" : "ok",
    );
  if (windows)
    await check("PowerShell encoding", () =>
      command(runtime.shell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding.WebName",
      ]),
    );
  await checkEnvironment(runtime.shell, check, command);
  await check("Git configuration sources", async () => {
    try {
      const value = await command("git", [
        "config",
        "--show-origin",
        "--get-regexp",
        "^(user\\.|credential\\.|core\\.sshcommand|gpg\\.|commit\\.gpgsign)",
      ]);
      return `cwd=${process.cwd()}\n${value}
Repository-specific includeIf/configuration and actual authentication are verified separately by synchronization results`;
    } catch (error) {
      if ((error as { code?: number }).code === 1)
        return `cwd=${process.cwd()}; no matching configuration entries`;
      throw error;
    }
  });
  if (windows) {
    try {
      add(
        "SSH",
        `${await windowsExecutable("ssh")}; PATH entry only; Git may use its bundled or configured SSH`,
      );
    } catch {
      add(
        "SSH",
        "No SSH executable in PATH; Git's bundled or configured SSH is verified by actual synchronization",
        "warn",
      );
    }
  }
  if (process.env.SSH_AUTH_SOCK)
    await check("SSH_AUTH_SOCK", async () => {
      const path = process.env.SSH_AUTH_SOCK!;
      if (windows)
        return `${path}; configured endpoint; authentication is verified by actual synchronization`;
      if (!(await stat(path)).isSocket()) throw new Error(`${path} is not a socket`);
      await access(path, constants.R_OK | constants.W_OK);
      return `${path}; accessible; authentication must be verified by an actual synchronization`;
    });
  return { runtime: true, items };
}
export async function doctorCli() {
  const config = { ...(await agentPaths()), limits: defaultAgentLimits };
  let report: DoctorReport;
  try {
    report = await localRequest<DoctorReport>(config, "doctor");
  } catch (error) {
    report = await diagnose(config, AbortSignal.timeout(config.limits.rpcTimeout));
    try {
      await agentConfig();
    } catch (error) {
      report.items.push({
        name: "Configuration on disk",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    report.items.unshift({
      name: "Local connection",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  for (const item of report.items) console.log(`[${item.status}] ${item.name}: ${item.detail}`);
  if (report.items.some((item) => item.status === "error")) process.exitCode = 1;
}
