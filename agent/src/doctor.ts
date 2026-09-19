import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { appVersion, terminalProfile, type Session } from "@kiteline/shared/protocol";
import { tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import { agentConfig, agentPaths, defaultAgentLimits, type AgentConfig } from "./config.js";
import { localRequest } from "./local.js";
import { packageDirectory, environmentFile } from "./installation.js";
import { checkFileHelper, checkToolVersion, toolRequirements } from "./tool-checks.js";

const execute = promisify(execFile);
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
  const command = async (file: string, args: string[], env = process.env) => {
    const result = await execute(file, args, {
      encoding: "utf8",
      env,
      signal,
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    return result.stdout.trim();
  };
  add(
    "Configuration",
    `data=${config.dataDir}; run=${config.runDir}; metadata=${join(config.dataDir, "agent.json")}`,
  );
  await check("Node", async () => {
    const info = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
    if (`v${info.node}` !== process.version || info.architecture !== process.arch)
      throw new Error(
        `Installation manifest does not match the current runtime: ${process.version} ${process.arch}`,
      );
    return `${process.execPath}; ${process.version} ${process.arch}; release=${info.version}`;
  });
  const native = join(packageDirectory, "dist/native");
  await check("Terminal build identity", async () => {
    const identity = JSON.parse(await readFile(join(native, "identity.json"), "utf8"));
    const release = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
    const recorderRequire = createRequire(join(packageDirectory, "terminal-recorder/package.json"));
    if (
      !isDeepStrictEqual(release.native, identity) ||
      recorderRequire("@xterm/headless/package.json").version !== identity.headless ||
      recorderRequire("@xterm/addon-serialize/package.json").version !== identity.serialize
    )
      throw new Error(
        "Recorder dependencies or release manifest do not match the terminal build identity",
      );
    const hash = async (file: string) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    if (
      identity.architecture !== process.arch ||
      identity.profile !== terminalProfile ||
      (await hash(tmuxBinary)) !== identity.tmuxBinary ||
      (await hash(join(native, "bin/rename-noreplace"))) !== identity.helperBinary
    )
      throw new Error(
        "Native components, architecture, or terminalProfile do not match the build identity",
      );
    await access(join(packageDirectory, "terminal-recorder/dist/main.js"), constants.R_OK);
    return `tmux=${identity.tmux}; profile=${identity.profile}; patch=${identity.patch}; headless=${identity.headless}; xterm=${identity.xterm}`;
  });
  for (const name of ["tmux", "rename-noreplace"]) {
    await check(`${name} shared libraries`, async () => {
      const result = await command("ldd", [join(native, "bin", name)]);
      if (result.includes("not found")) throw new Error(result);
      return result;
    });
  }
  await check("tmux execution", () => command(tmuxBinary, ["-V"]));
  await check("Helper execution", () =>
    checkFileHelper(join(native, "bin/rename-noreplace"), command),
  );
  if (!runtime) {
    add(
      "Runtime environment",
      "Runtime environment has not been checked; only the current installation and configuration were checked",
      "warn",
    );
    return { runtime: false, items };
  }
  add(
    "Agent",
    `version=${appVersion}; pid=${process.pid}; uid=${process.getuid?.()}; cwd=${process.cwd()}; metadata revision=${runtime.revision}`,
  );
  add("Environment", `HOME=${process.env.HOME ?? ""}\nPATH=${process.env.PATH ?? ""}`);
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
  for (const session of runtime.sessions)
    add(
      `Terminal ${session.id}`,
      `${session.state}; recording=${session.webStatus}${session.webReason ? `; ${session.webReason}` : ""}`,
      session.webStatus === "unavailable" ? "warn" : "ok",
    );
  await check("locale", async () => {
    const encoding = await command("locale", ["charmap"]);
    const values = `LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}`;
    if (!/^UTF-?8$/i.test(encoding))
      throw new Error(
        `${encoding}; ${values}; correct ${environmentFile} or the container environment`,
      );
    return `${encoding}; ${values}`;
  });
  await check("terminfo", async () => {
    await command("infocmp", ["-x", "tmux-256color"], tmuxEnvironment());
    return `tmux-256color; TERMINFO_DIRS=${tmuxEnvironment().TERMINFO_DIRS}`;
  });
  await check("Shell", async () => {
    await access(runtime.shell, constants.X_OK);
    return runtime.shell;
  });
  for (const tool of toolRequirements)
    await check(tool.file, () => checkToolVersion(tool, command));
  await check("Git configuration sources", async () => {
    try {
      const value = await command("git", [
        "config",
        "--show-origin",
        "--show-scope",
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
  await check("SSH", () => command("sh", ["-c", 'command -v "$1"', "sh", "ssh"]));
  for (const key of ["credential.helper", "core.sshCommand", "gpg.program", "gpg.ssh.program"]) {
    let values: string;
    try {
      values = await command("git", [
        "config",
        "--null",
        key === "credential.helper" ? "--get-all" : "--get",
        key,
      ]);
    } catch (error) {
      if ((error as { code?: number }).code !== 1)
        add(key, error instanceof Error ? error.message : String(error), "error");
      continue;
    }
    const configured = values.split("\0").slice(0, -1);
    // An empty helper resets inherited helpers; the other keys use Git's last value.
    for (const value of configured.slice(configured.lastIndexOf("") + 1)) {
      const first = /^([A-Za-z0-9_./+-]+)(?:\s|$)/.exec(value)?.[1];
      if (!first) {
        add(
          key,
          "A complex command is configured; executable dependencies have not been verified",
          "warn",
        );
        continue;
      }
      await check(key, async () => {
        let program = first;
        if (key === "credential.helper" && !first.startsWith("/")) {
          program = `git-credential-${first}`;
          const bundled = join(await command("git", ["--exec-path"]), program);
          try {
            await access(bundled, constants.X_OK);
            return `${bundled}; entry point is executable`;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const path = await command("sh", ["-c", 'command -v "$1"', "sh", program]);
        await access(path, constants.X_OK);
        return `${path}; entry point is executable`;
      });
    }
  }
  if (process.env.SSH_AUTH_SOCK)
    await check("SSH_AUTH_SOCK", async () => {
      const path = process.env.SSH_AUTH_SOCK!;
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
