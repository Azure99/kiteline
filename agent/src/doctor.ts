import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { terminalProfile, type Session } from "@kiteline/shared/protocol";
import { tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import { agentConfig, agentPaths, defaultAgentLimits, type AgentConfig } from "./config.js";
import { localRequest } from "./local.js";
import { packageDirectory, environmentFile } from "./installation.js";

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
    "配置",
    `data=${config.dataDir}; run=${config.runDir}; metadata=${join(config.dataDir, "agent.json")}`,
  );
  await check("Node", async () => {
    const info = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
    if (`v${info.node}` !== process.version || info.architecture !== process.arch)
      throw new Error(`安装清单与当前运行时不符: ${process.version} ${process.arch}`);
    return `${process.execPath}; ${process.version} ${process.arch}; release=${info.version}`;
  });
  const native = join(packageDirectory, "dist/native");
  await check("终端构建身份", async () => {
    const identity = JSON.parse(await readFile(join(native, "identity.json"), "utf8"));
    const release = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
    const recorderRequire = createRequire(join(packageDirectory, "terminal-recorder/package.json"));
    if (
      !isDeepStrictEqual(release.native, identity) ||
      recorderRequire("@xterm/headless/package.json").version !== identity.headless ||
      recorderRequire("@xterm/addon-serialize/package.json").version !== identity.serialize
    )
      throw new Error("recorder 依赖或发布清单与终端构建身份不匹配");
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
      throw new Error("原生组件、架构或 terminalProfile 与构建身份不匹配");
    await access(join(packageDirectory, "terminal-recorder/dist/main.js"), constants.R_OK);
    return `tmux=${identity.tmux}; profile=${identity.profile}; patch=${identity.patch}; headless=${identity.headless}; xterm=${identity.xterm}`;
  });
  for (const name of ["tmux", "rename-noreplace"]) {
    await check(`${name} 动态库`, async () => {
      const result = await command("ldd", [join(native, "bin", name)]);
      if (result.includes("not found")) throw new Error(result);
      return result;
    });
  }
  await check("tmux 执行", () => command(tmuxBinary, ["-V"]));
  await check("helper 执行", async () => {
    try {
      await command(join(native, "bin/rename-noreplace"), []);
    } catch (error) {
      if ((error as { code?: number }).code === 2) return "可装载，usage 退出码 2";
      throw error;
    }
    throw new Error("helper 未返回预期 usage 状态");
  });
  if (!runtime) {
    add("运行环境", "尚未检查运行环境；仅检查当前安装和配置", "warn");
    return { runtime: false, items };
  }
  add(
    "Agent",
    `pid=${process.pid}; uid=${process.getuid?.()}; cwd=${process.cwd()}; metadata revision=${runtime.revision}`,
  );
  add("环境", `HOME=${process.env.HOME ?? ""}\nPATH=${process.env.PATH ?? ""}`);
  add(
    "server",
    runtime.server + (runtime.connected ? " 已连接" : " 未连接"),
    runtime.connected ? "ok" : "warn",
  );
  add(
    "记录器",
    runtime.recorderPid ? `pid=${runtime.recorderPid}` : "未运行",
    runtime.sessions.length && !runtime.recorderPid ? "warn" : "ok",
  );
  for (const session of runtime.sessions)
    add(
      `终端 ${session.id}`,
      `${session.state}; recording=${session.webStatus}${session.webReason ? `; ${session.webReason}` : ""}`,
      session.webStatus === "unavailable" ? "warn" : "ok",
    );
  await check("locale", async () => {
    const encoding = await command("locale", ["charmap"]);
    const values = `LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}`;
    if (!/^UTF-?8$/i.test(encoding))
      throw new Error(`${encoding}; ${values}; 请修正 ${environmentFile} 或容器环境`);
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
  for (const [file, minimum] of [
    ["git", "2.43"],
    ["rg", "14.0"],
  ] as const) {
    await check(file, async () => {
      const version = (await command(file, ["--version"])).split("\n")[0]!;
      const found = /(\d+)\.(\d+)/.exec(version),
        required = minimum.split(".").map(Number);
      if (
        !found ||
        Number(found[1]) < required[0]! ||
        (Number(found[1]) === required[0] && Number(found[2]) < required[1]!)
      )
        throw new Error(`${version}; 需要 >= ${minimum}`);
      return version;
    });
  }
  await check("Git 配置来源", async () => {
    try {
      const value = await command("git", [
        "config",
        "--show-origin",
        "--show-scope",
        "--get-regexp",
        "^(user\\.|credential\\.|core\\.sshcommand|gpg\\.|commit\\.gpgsign)",
      ]);
      return `cwd=${process.cwd()}\n${value}\n仓库专属 includeIf/配置及实际认证另由同步结果确认`;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return `cwd=${process.cwd()}; 未配置匹配项`;
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
        add(key, "已配置复杂命令，程序依赖尚未核验", "warn");
        continue;
      }
      await check(key, async () => {
        let program = first;
        if (key === "credential.helper" && !first.startsWith("/")) {
          program = `git-credential-${first}`;
          const bundled = join(await command("git", ["--exec-path"]), program);
          try {
            await access(bundled, constants.X_OK);
            return `${bundled}; 入口可执行`;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const path = await command("sh", ["-c", 'command -v "$1"', "sh", program]);
        await access(path, constants.X_OK);
        return `${path}; 入口可执行`;
      });
    }
  }
  if (process.env.SSH_AUTH_SOCK)
    await check("SSH_AUTH_SOCK", async () => {
      const path = process.env.SSH_AUTH_SOCK!;
      if (!(await stat(path)).isSocket()) throw new Error(`${path} 不是 socket`);
      await access(path, constants.R_OK | constants.W_OK);
      return `${path}; 可访问，认证结果需实际同步验证`;
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
        name: "磁盘配置",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    report.items.unshift({
      name: "本机连接",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  for (const item of report.items) console.log(`[${item.status}] ${item.name}: ${item.detail}`);
  if (report.items.some((item) => item.status === "error")) process.exitCode = 1;
}
