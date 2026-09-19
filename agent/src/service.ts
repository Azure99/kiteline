import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, parseEnv, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { localRequest } from "./local.js";
import { atomicJson } from "./config.js";
import {
  environmentFile,
  installationFile,
  installationPaths,
  installDirectory,
  packageDirectory,
  readInstallation,
  unitName,
  type Installation,
} from "./installation.js";

const execute = promisify(execFile);
const unitFile = `/etc/systemd/system/${unitName}`;
const launcher = "/usr/local/bin/kiteline-agent";
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function stopped(installation: Installation) {
  const { dataDir } = await installationPaths(installation);
  if (
    await lockfile.check(dataDir, {
      lockfilePath: join(dataDir, "process.lock"),
      realpath: false,
    })
  )
    throw new Error("Agent 仍在运行。请先停止前台进程或 service stop；此操作未结束现有任务。");
}
async function unitIs(state: "active" | "enabled") {
  if (!(await exists(unitFile))) return false;
  try {
    const value = await command("systemctl", [`is-${state}`, unitName]);
    return value === state || (state === "enabled" && value === "enabled-runtime");
  } catch (error) {
    if ([1, 3, 4].includes((error as { code: number }).code)) return false;
    throw error;
  }
}
async function command(file: string, args: string[], cwd?: string) {
  return (
    await execute(file, args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 })
  ).stdout.trim();
}
async function interactive(file: string, args: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
async function hash(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function verifyPackage(directory: string) {
  const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  if (release.kind !== "agent" || release.architecture !== process.arch)
    throw new Error("需要与当前 Linux 架构匹配的完整 agent 包");
  await command("sha256sum", ["--status", "--check", "SHA256SUMS"], directory);
  if ((await command(join(directory, "runtime/bin/node"), ["--version"])) !== `v${release.node}`)
    throw new Error("随包 Node 与安装清单不符");
  if (
    (await command(join(directory, "dist/native/bin/tmux"), ["-V"])) !==
    `tmux ${release.native.tmux}`
  )
    throw new Error("随包 tmux 与安装清单不符");
  if ((await command(join(directory, "bin/kiteline-agent"), ["--version"])) !== release.version)
    throw new Error("agent 与安装清单不符");
  return release.version as string;
}
async function confirm(message: string, yes: boolean) {
  console.log(message);
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error("需要交互确认，或本次明确传入 --yes");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await reader.question("输入 yes 继续: ")).trim() !== "yes") throw new Error("已取消");
  } finally {
    reader.close();
  }
}
async function account(name: string, service: boolean): Promise<Installation> {
  const fields = (await command("getent", ["passwd", name])).split(":");
  const uid = Number(fields[2]),
    gid = Number(fields[3]),
    home = fields[5];
  if (
    !Number.isInteger(uid) ||
    (service && uid === 0) ||
    !home?.startsWith("/") ||
    fields.length !== 7
  )
    throw new Error(service ? "请指定已有的非 root 项目用户" : "请指定已有的项目用户");
  return { user: fields[0]!, uid, gid, home };
}
async function checkServiceEnvironment(installation: Installation) {
  const source = await readFile(environmentFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const env = {
    HOME: installation.home,
    PATH: `${installation.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    ...parseEnv(source),
  };
  await command("runuser", [
    "-u",
    installation.user,
    "--",
    "env",
    "-i",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    launcher,
    "check",
    "--service",
  ]);
}
async function writeUnit(installation: Installation, source = installDirectory) {
  const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
  const replacements: Record<string, string> = {
    USER: installation.user.replaceAll("%", "%%"),
    HOME: installation.home.replaceAll("%", "%%"),
    HOME_ENV: quote(`HOME=${installation.home}`),
    PATH_ENV: quote(`PATH=${installation.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`),
  };
  const template = await readFile(join(source, "deploy/kiteline-agent.service"), "utf8");
  await writeFile(
    unitFile,
    template.replace(/@(USER|HOME|HOME_ENV|PATH_ENV)@/g, (_, key: string) => replacements[key]!),
    { mode: 0o644 },
  );
  await command("systemctl", ["daemon-reload"]);
}
async function installProgram(user: string, service: boolean) {
  const installation = await account(user, service);
  const previous = await readInstallation();
  if (previous) {
    if (!service) throw new Error("程序已经安装，请使用 service upgrade 明确升级");
    if (previous.uid !== installation.uid) throw new Error(`当前安装属于 ${previous.user}`);
    if ((await verifyPackage(packageDirectory)) !== (await verifyPackage(installDirectory)))
      throw new Error("已安装其他版本，请先明确执行 service upgrade");
    await stopped(previous);
    await checkServiceEnvironment(previous);
    await writeUnit(previous);
    await command("systemctl", ["enable", unitName]);
    console.log("已启用系统服务，尚未启动。请执行 sudo kiteline-agent service start。");
    return;
  }
  for (const path of [installDirectory, unitFile, launcher]) {
    try {
      await lstat(path);
      throw new Error(`${path} 已存在，请先确认其用途`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await verifyPackage(packageDirectory);
  if (service) await command("systemctl", ["daemon-reload"]);
  await mkdir("/opt", { recursive: true });
  try {
    await writeFile(
      environmentFile,
      `# Directory values: double-quoted absolute paths, without escapes.\nKITELINE_AGENT_HOME=${JSON.stringify(join(installation.home, ".local/share/kiteline-agent"))}\nKITELINE_AGENT_RUN_DIR=${JSON.stringify(join(installation.home, ".local/share/kiteline-agent/run"))}\n`,
      { flag: "wx", mode: 0o640 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chown(environmentFile, 0, installation.gid);
  await chmod(environmentFile, 0o640);
  await installationPaths(installation);
  try {
    await cp(packageDirectory, installDirectory, { recursive: true, verbatimSymlinks: true });
    await mkdir("/usr/local/bin", { recursive: true });
    await symlink(join(installDirectory, "bin/kiteline-agent"), launcher);
    await atomicJson(installationFile, installation);
    await chmod(installationFile, 0o644);
    if (service) {
      await checkServiceEnvironment(installation);
      await writeUnit(installation);
      await command("systemctl", ["enable", unitName]);
    }
  } catch (error) {
    if (service) await command("systemctl", ["disable", unitName]).catch(() => {});
    for (const path of [launcher, unitFile, installationFile, installDirectory])
      await rm(path, { recursive: true, force: true });
    if (service) await command("systemctl", ["daemon-reload"]).catch(() => {});
    throw error;
  }
  console.log(
    `已安装，尚未启动。以 ${installation.user} 运行 kiteline-agent bind --server <https-origin>，然后 ${service ? "sudo kiteline-agent service start" : "kiteline-agent run"}。\n环境配置: ${environmentFile}`,
  );
}
async function install(user: string, service: boolean) {
  await mkdir("/opt", { recursive: true });
  const release = await lockfile.lock("/opt", {
    lockfilePath: "/opt/.kiteline-agent-install.lock",
    realpath: false,
  });
  try {
    await installProgram(user, service);
  } finally {
    await release();
  }
}
export async function installCli(args: string[]) {
  const { values } = parseArgs({ args, options: { user: { type: "string" } } });
  if (!values.user) throw new Error("Usage: kiteline-agent install --user PROJECT_USER");
  if (process.getuid?.() !== 0) throw new Error("安装程序需要 sudo 或 root；安装后以项目用户运行");
  await install(values.user, false);
}
async function waitReady(installation: Installation) {
  const paths = await installationPaths(installation);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await localRequest({ ...paths, limits: { rpcTimeout: 1000 } }, "workspaces.list");
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error("服务未能完成本机 RPC 初始化");
}
async function upgrade(installation: Installation, archive: string, yes: boolean) {
  const runningService = await unitIs("active");
  if (!runningService) await stopped(installation);
  const restartService = runningService || (await unitIs("enabled"));
  const hasUnit = await exists(unitFile);
  const path = resolve(archive);
  const checksum = (await readFile(path + ".sha256", "utf8")).trim().split(/\s+/)[0];
  if (!checksum || (await hash(path)) !== checksum) throw new Error("安装包 SHA256 校验失败");
  const temporary = await mkdtemp("/opt/.kiteline-upgrade-");
  const replacement = join(temporary, "new"),
    previous = join(temporary, "previous");
  let keepPrevious = false;
  try {
    await mkdir(replacement);
    await command("tar", [
      "-xzf",
      path,
      "--strip-components=1",
      "--no-same-owner",
      "-C",
      replacement,
    ]);
    const version = await verifyPackage(replacement);
    try {
      const sessions = await command("runuser", [
        "-u",
        installation.user,
        "--",
        "env",
        "-u",
        "KITELINE_AGENT_HOME",
        "-u",
        "KITELINE_AGENT_RUN_DIR",
        launcher,
        "terminal",
        "list",
      ]);
      console.log(sessions || "没有活动终端。");
    } catch {
      console.log("未能读取当前会话；服务仍可能持有任务。");
    }
    await confirm(
      `升级到 ${version} 会结束此 agent 的全部终端任务，保留绑定、配置和 workspace。`,
      yes,
    );
    if (runningService) await command("systemctl", ["stop", unitName]);
    await stopped(installation);
    await rename(installDirectory, previous);
    keepPrevious = true;
    try {
      await rename(replacement, installDirectory);
      if (hasUnit) await writeUnit(installation);
      if (restartService) {
        await command("systemctl", ["start", unitName]);
        await waitReady(installation);
      }
    } catch (error) {
      if (restartService) await command("systemctl", ["stop", unitName]);
      await rm(installDirectory, { recursive: true, force: true });
      await rename(previous, installDirectory);
      keepPrevious = false;
      if (hasUnit) await writeUnit(installation);
      if (restartService) await command("systemctl", ["start", unitName]).catch(() => {});
      throw new Error("升级失败，已恢复完整旧安装；原终端已结束。请检查 service status/logs。", {
        cause: error,
      });
    }
    keepPrevious = false;
    console.log(
      `已升级到 ${version}。${restartService ? "服务已启动，原终端已结束。" : "未启动，请以项目用户执行 kiteline-agent run。"}`,
    );
  } finally {
    if (keepPrevious) console.error(`旧安装保留在 ${previous}，请恢复后检查服务。`);
    else await rm(temporary, { recursive: true, force: true });
  }
}
async function uninstall(installation: Installation, purge: boolean, yes: boolean) {
  if (!(await unitIs("active"))) await stopped(installation);
  const hasUnit = await exists(unitFile);
  const paths = await installationPaths(installation);
  await confirm(
    `卸载会结束全部终端并移除程序。${purge ? `同时删除状态 ${paths.dataDir}。` : `保留状态 ${paths.dataDir}。`}`,
    yes,
  );
  if (hasUnit) await command("systemctl", ["disable", "--now", unitName]);
  await stopped(installation);
  await rm(unitFile, { force: true });
  await rm(launcher, { force: true });
  await rm(installDirectory, { recursive: true });
  await rm(installationFile, { force: true });
  if (hasUnit) await command("systemctl", ["daemon-reload"]);
  if (purge)
    for (const name of ["agent.json", "connection.json", "config.json", "temporary-files.json"])
      await rm(join(paths.dataDir, name), { force: true });
  console.log(`已卸载；${purge ? "已清理 agent 状态" : "状态与环境配置保留"}。`);
}
export async function serviceCli(args: string[]) {
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      user: { type: "string" },
      archive: { type: "string" },
      yes: { type: "boolean", default: false },
      "purge-state": { type: "boolean", default: false },
      follow: { type: "boolean", default: false },
    },
  });
  const action = args[0];
  if (action === "status") {
    process.exitCode = await interactive("systemctl", ["status", "--no-pager", unitName]);
    return;
  }
  if (action === "logs") {
    process.exitCode = await interactive("journalctl", [
      "--unit",
      unitName,
      "--no-pager",
      "--lines",
      "100",
      ...(values.follow ? ["--follow"] : []),
    ]);
    return;
  }
  if (process.getuid?.() !== 0) throw new Error("service 安装、启停、升级和卸载需要 sudo 或 root");
  if (action === "install") {
    if (!values.user) throw new Error("Usage: kiteline-agent service install --user PROJECT_USER");
    await install(values.user, true);
    return;
  }
  const installation = await readInstallation();
  if (!installation) throw new Error("尚未安装 kiteline-agent");
  if (action === "check") {
    if (installation.uid === 0) throw new Error("系统服务需要非 root 项目用户");
    await checkServiceEnvironment(installation);
    console.log("服务环境检查通过。");
  } else if (action === "start" || action === "stop") {
    if (action === "start" && !(await unitIs("active"))) {
      await stopped(installation);
      await checkServiceEnvironment(installation);
    }
    await command("systemctl", [action, unitName]);
    if (action === "start") await waitReady(installation);
  } else if (action === "disable") {
    await stopped(installation);
    await command("systemctl", ["disable", unitName]);
    console.log("已禁用开机服务。以项目用户执行 kiteline-agent run 可前台运行。");
  } else if (action === "upgrade") {
    if (!values.archive)
      throw new Error("Usage: kiteline-agent service upgrade --archive RELEASE.tar.gz [--yes]");
    await upgrade(installation, values.archive, values.yes);
  } else if (action === "uninstall")
    await uninstall(installation, values["purge-state"], values.yes);
  else
    throw new Error(
      "Usage: kiteline-agent service install/check/start/status/logs/stop/disable/upgrade/uninstall",
    );
}
