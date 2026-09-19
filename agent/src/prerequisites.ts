import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import { agentConfig } from "./config.js";
import { packageDirectory } from "./installation.js";

const execute = promisify(execFile);

export async function checkPrerequisites(service = false) {
  const config = await agentConfig();
  const failures: string[] = [];
  async function check(name: string, action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function command(file: string, args: string[], env = process.env) {
    return (
      await execute(file, args, { env, encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 })
    ).stdout.trim();
  }
  for (const [file, major, minor] of [
    ["git", 2, 43],
    ["rg", 14, 0],
  ] as const) {
    await check(file, async () => {
      const line = (await command(file, ["--version"])).split("\n")[0]!;
      const version = /(\d+)\.(\d+)/.exec(line);
      if (
        !version ||
        Number(version[1]) < major ||
        (Number(version[1]) === major && Number(version[2]) < minor)
      )
        throw new Error(`需要 >= ${major}.${minor}，当前 ${line}`);
    });
  }
  await check("SSH", () => command("ssh", ["-V"]));
  await check("Shell", () => access(config.shell, constants.X_OK));
  await check("UTF-8 locale", async () => {
    if (!/^UTF-?8$/i.test(await command("locale", ["charmap"])))
      throw new Error("请设置已安装的 UTF-8 locale，例如 LANG=C.UTF-8，并检查 LC_ALL/LC_CTYPE");
  });
  await check("terminfo", () => command("infocmp", ["-x", "tmux-256color"], tmuxEnvironment()));
  await check("随包 tmux", () => command(tmuxBinary, ["-V"]));
  await check("随包文件 helper", async () => {
    try {
      await command(join(packageDirectory, "dist/native/bin/rename-noreplace"), []);
    } catch (error) {
      if ((error as { code?: number }).code === 2) return;
      throw error;
    }
    throw new Error("helper 未返回预期 usage 状态");
  });
  await check("运行目录", async () => {
    if (Buffer.byteLength(join(config.runDir, "0".repeat(36), "tmux.sock")) > 103)
      throw new Error("KITELINE_AGENT_RUN_DIR 过长，请配置较短的用户可写目录");
    const paths =
      service && config.runDir === "/run/kiteline-agent"
        ? [config.dataDir]
        : [config.dataDir, config.runDir];
    for (const path of paths) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await access(path, constants.W_OK | constants.X_OK);
    }
  });
  if (failures.length)
    throw new Error(
      `接入检查未通过：\n${failures.join("\n")}\nUbuntu 24.04 基础依赖：\n${process.getuid?.() === 0 ? "" : "sudo "}apt-get update && ${process.getuid?.() === 0 ? "" : "sudo "}apt-get install -y git ripgrep openssh-client ncurses-bin locales\n安装依赖或修正以上配置后，重新执行接入命令。`,
    );
  console.log("接入检查通过。");
}
