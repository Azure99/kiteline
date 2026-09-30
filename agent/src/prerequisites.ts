import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  msysPath,
  terminfoDirectory,
  tmuxBinary,
  tmuxEnvironment,
} from "@kiteline/shared/terminal/node";
import { windowsNative } from "@kiteline/shared/windows/native";
import { agentConfig, privateDirectory } from "./config.js";
import { packageDirectory } from "./installation.js";
import { checkWindowsComponents } from "./windows-components.js";
import { checkMacosComponents } from "./macos-components.js";
import {
  bundledRipgrep,
  checkBundledRipgrep,
  checkFileHelper,
  checkToolVersion,
  toolRequirements,
  toolCommand,
} from "./tool-checks.js";

export async function checkPrerequisites() {
  const config = await agentConfig();
  const windows = process.platform === "win32";
  const macos = process.platform === "darwin";
  const failures: string[] = [];
  async function check(name: string, action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const command = (file: string, args: string[], env = process.env) =>
    toolCommand(file, args, { env, timeout: 5000 });
  if (windows) await check("Windows component identity", () => checkWindowsComponents());
  if (macos) await check("macOS component identity", () => checkMacosComponents());
  for (const tool of toolRequirements)
    await check(tool.file, () => checkToolVersion(tool, command));
  if (bundledRipgrep) await check("Bundled ripgrep", () => checkBundledRipgrep(command));
  if (!windows) {
    await check("SSH", () => command("ssh", ["-V"]));
    await check("flock", () =>
      command(macos ? join(packageDirectory, "dist/native/bin/flock") : "flock", ["--version"]),
    );
  }
  await check("Shell", () =>
    windows
      ? checkToolVersion({ file: config.shell, major: 7, minor: 0 }, command)
      : access(config.shell, constants.X_OK),
  );
  if (!windows)
    await check("UTF-8 locale", async () => {
      try {
        const encoding = await command("locale", ["charmap"]);
        if (!/^UTF-?8$/i.test(encoding)) throw new Error(`Character map is ${encoding}`);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nChoose an installed UTF-8 locale (locale -a). Current LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}. LC_ALL overrides LC_CTYPE and LANG. Correct the launching Shell or your external process manager's environment.`,
          { cause: error },
        );
      }
    });
  await check("terminfo", async () => {
    if (!windows) return command("infocmp", ["-x", "tmux-256color"], tmuxEnvironment());
    if (!(await stat(terminfoDirectory)).isDirectory())
      throw new Error("Private terminfo directory is missing");
  });
  await check("Bundled tmux", () => command(tmuxBinary, ["-V"], tmuxEnvironment()));
  await check("Bundled file helper", () =>
    windows
      ? windowsNative().fileAttributes(join(packageDirectory, "dist/native"))
      : checkFileHelper(join(packageDirectory, "dist/native/bin/rename-noreplace"), command),
  );
  if (macos)
    await check("Bundled entry name helper", () =>
      checkFileHelper(join(packageDirectory, "dist/native/bin/entry-name"), command),
    );
  await check("Runtime directory", async () => {
    const socket = join(config.runDir, "0".repeat(36), "tmux.sock");
    if (Buffer.byteLength(windows ? msysPath(socket) : socket) > 103)
      throw new Error(
        "KITELINE_AGENT_RUN_DIR is too long; configure a shorter user-writable directory",
      );
    for (const path of [config.dataDir, config.runDir]) {
      await privateDirectory(path);
      await access(path, constants.W_OK | constants.X_OK);
    }
  });
  if (failures.length) {
    if (windows)
      throw new Error(
        `Setup checks failed:\n${failures.join("\n")}\nProvide PowerShell 7 and native Git in the launching environment. Reinstall the matching complete package for bundled component failures.`,
      );
    if (macos)
      throw new Error(
        `Setup checks failed:\n${failures.join("\n")}\nProvide Git >= 2.23, an executable Shell and a UTF-8 locale in the launching environment. Reinstall the matching complete package for bundled component failures.`,
      );
    const system = parseEnv(await readFile("/etc/os-release", "utf8").catch(() => ""));
    const root = process.getuid?.() === 0 ? "" : "sudo ";
    const installHint =
      system.ID === "alpine"
        ? `${root}apk add git${bundledRipgrep ? "" : " ripgrep"} openssh-client ncurses musl-locales util-linux`
        : system.ID === "ubuntu" || system.ID === "debian"
          ? `${root}apt-get update && ${root}apt-get install -y git openssh-client ncurses-bin locales util-linux${bundledRipgrep ? "" : " ripgrep"}`
          : system.ID === "centos"
            ? `${root}yum install -y openssh-clients ncurses glibc-common util-linux`
            : "Install SSH, util-linux (flock), locale and infocmp using your system package manager.";
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
