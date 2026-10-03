import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { terminfoDirectory, tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import { windowsNative } from "@kiteline/shared/windows/native";
import { agentConfig, privateDirectory } from "./config.js";
import { packageDirectory } from "./install/paths.js";
import { checkRunDir } from "./terminal/sessions.js";
import {
  checkBundledRipgrep,
  checkFileHelper,
  checkToolVersion,
  toolRequirements,
  toolCommand,
} from "./tools.js";

type Command = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
type Check = (name: string, action: () => Promise<string>) => Promise<void>;

export async function checkComponents(check: Check, command: Command) {
  const windows = process.platform === "win32";
  const macos = process.platform === "darwin";
  const native = join(packageDirectory, "dist/native");
  await check("Bundled ripgrep", () => checkBundledRipgrep(command));
  await check("Bundled tmux", () => command(tmuxBinary, ["-V"], tmuxEnvironment()));
  await check("Bundled file helper", async () => {
    if (!windows) return checkFileHelper(join(native, "bin/rename-noreplace"), command);
    await windowsNative().fileAttributes(native);
    return "Windows native filesystem API is loadable";
  });
  if (macos) {
    await check("Bundled entry name helper", () =>
      checkFileHelper(join(native, "bin/entry-name"), command),
    );
    await check("flock", () => command(join(native, "bin/flock"), ["--version"]));
  }
}

export async function checkHostEnvironment(shell: string, check: Check, command: Command) {
  const windows = process.platform === "win32";
  for (const tool of toolRequirements)
    await check(tool.file, () => checkToolVersion(tool, command));
  if (!windows)
    await check("SSH", async () => {
      await command("ssh", ["-V"]);
      return "ssh -V succeeded";
    });
  if (process.platform === "linux") await check("flock", () => command("flock", ["--version"]));
  await check("Shell", async () => {
    await access(shell, constants.X_OK);
    return windows
      ? `${shell}; ${await checkToolVersion({ file: shell, major: 7, minor: 0 }, command)}`
      : shell;
  });
  if (!windows)
    await check("UTF-8 locale", async () => {
      try {
        const encoding = await command("locale", ["charmap"]);
        if (!/^UTF-?8$/i.test(encoding)) throw new Error(`Character map is ${encoding}`);
        return `${encoding}; LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}`;
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nChoose an installed UTF-8 locale (locale -a). Current LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}. LC_ALL overrides LC_CTYPE and LANG. Correct the launching Shell or your external process manager's environment.`,
          { cause: error },
        );
      }
    });
  await check("terminfo", async () => {
    if (!windows) {
      await command("infocmp", ["-x", "tmux-256color"], tmuxEnvironment());
      return `tmux-256color; TERMINFO_DIRS=${tmuxEnvironment().TERMINFO_DIRS}`;
    }
    if (!(await stat(terminfoDirectory)).isDirectory())
      throw new Error("Private terminfo directory is missing");
    return terminfoDirectory;
  });
}

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
  await checkComponents(check, command);
  await checkHostEnvironment(config.shell, check, command);
  await check("Runtime directory", async () => {
    checkRunDir(config.runDir);
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
    throw new Error(
      `Setup checks failed:
${failures.join("\n")}
Provide ${toolRequirements.map(({ file, major, minor }) => `${file} >= ${major}.${minor}.0`).join(" and ")}, SSH, an executable Shell, a UTF-8 locale, infocmp and flock in the launching environment. Reinstall the matching complete package for bundled component failures.`,
    );
  }
  console.log("Setup checks passed.");
}
