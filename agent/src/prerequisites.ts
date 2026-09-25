import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import { tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import { agentConfig } from "./config.js";
import { packageDirectory, environmentFile } from "./installation.js";
import {
  bundledRipgrep,
  checkBundledRipgrep,
  checkFileHelper,
  checkToolVersion,
  toolRequirements,
} from "./tool-checks.js";

const execute = promisify(execFile);

export async function checkPrerequisites() {
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
  for (const tool of toolRequirements)
    await check(tool.file, () => checkToolVersion(tool, command));
  if (bundledRipgrep) await check("Bundled ripgrep", () => checkBundledRipgrep(command));
  await check("SSH", () => command("ssh", ["-V"]));
  await check("flock (util-linux)", () => command("flock", ["--version"]));
  await check("Shell", () => access(config.shell, constants.X_OK));
  await check("UTF-8 locale", async () => {
    try {
      const encoding = await command("locale", ["charmap"]);
      if (!/^UTF-?8$/i.test(encoding)) throw new Error(`Character map is ${encoding}`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nChoose an installed UTF-8 locale (locale -a). Current LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}. LC_ALL overrides LC_CTYPE and LANG. Correct the launching Shell for foreground use, or ${environmentFile} for systemd; initial setup also checks the launching Shell.`,
        { cause: error },
      );
    }
  });
  await check("terminfo", () => command("infocmp", ["-x", "tmux-256color"], tmuxEnvironment()));
  await check("Bundled tmux", () => command(tmuxBinary, ["-V"]));
  await check("Bundled file helper", () =>
    checkFileHelper(join(packageDirectory, "dist/native/bin/rename-noreplace"), command),
  );
  await check("Runtime directory", async () => {
    if (Buffer.byteLength(join(config.runDir, "0".repeat(36), "tmux.sock")) > 103)
      throw new Error(
        "KITELINE_AGENT_RUN_DIR is too long; configure a shorter user-writable directory",
      );
    for (const path of [config.dataDir, config.runDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await access(path, constants.W_OK | constants.X_OK);
    }
  });
  if (failures.length) {
    const system = parseEnv(await readFile("/etc/os-release", "utf8").catch(() => ""));
    const root = process.getuid?.() === 0 ? "" : "sudo ";
    const installHint =
      system.ID === "alpine"
        ? `${root}apk add git${bundledRipgrep ? "" : " ripgrep"} openssh-client ncurses musl-locales util-linux`
        : system.ID === "ubuntu" || system.ID === "debian"
          ? `${root}apt-get update && ${root}apt-get install -y git openssh-client ncurses-bin locales util-linux${bundledRipgrep ? "" : " ripgrep"}`
          : system.ID === "centos"
            ? `${root}yum install -y openssh-clients ncurses glibc-common util-linux`
            : "Install SSH, util-linux (flock/runuser), locale and infocmp using your system package manager.";
    throw new Error(
      `Setup checks failed:
${failures.join("\n")}
Base dependencies (${system.PRETTY_NAME ?? "Linux"}):
${installHint}
Also provide ${toolRequirements.map(({ file, major, minor }) => `${file} >= ${major}.${minor}.0`).join(" and ")}. If your distribution does not provide these versions, obtain suitable versions separately.
After installing the dependencies or correcting the configuration above, run the setup command again.`,
    );
  }
  console.log("Setup checks passed.");
}
