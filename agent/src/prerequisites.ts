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
        throw new Error(`Requires >= ${major}.${minor}; current: ${line}`);
    });
  }
  await check("SSH", () => command("ssh", ["-V"]));
  await check("Shell", () => access(config.shell, constants.X_OK));
  await check("UTF-8 locale", async () => {
    if (!/^UTF-?8$/i.test(await command("locale", ["charmap"])))
      throw new Error(
        "Set an installed UTF-8 locale, such as LANG=C.UTF-8, and check LC_ALL/LC_CTYPE",
      );
  });
  await check("terminfo", () => command("infocmp", ["-x", "tmux-256color"], tmuxEnvironment()));
  await check("Bundled tmux", () => command(tmuxBinary, ["-V"]));
  await check("Bundled file helper", async () => {
    try {
      await command(join(packageDirectory, "dist/native/bin/rename-noreplace"), []);
    } catch (error) {
      if ((error as { code?: number }).code === 2) return;
      throw error;
    }
    throw new Error("Helper did not return the expected usage status");
  });
  await check("Runtime directory", async () => {
    if (Buffer.byteLength(join(config.runDir, "0".repeat(36), "tmux.sock")) > 103)
      throw new Error(
        "KITELINE_AGENT_RUN_DIR is too long; configure a shorter user-writable directory",
      );
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
      `Setup checks failed:
${failures.join("\n")}
Ubuntu 24.04 base dependencies:
${process.getuid?.() === 0 ? "" : "sudo "}apt-get update && ${process.getuid?.() === 0 ? "" : "sudo "}apt-get install -y git ripgrep openssh-client ncurses-bin locales
After installing the dependencies or correcting the configuration above, run the setup command again.`,
    );
  console.log("Setup checks passed.");
}
