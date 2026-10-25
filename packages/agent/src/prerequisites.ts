import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { terminfoDirectory, tmuxBinary, tmuxEnvironment } from "@kiteline/shared/terminal/node";
import { windowsNative } from "@kiteline/shared/windows/native";
import { asError } from "@kiteline/shared/protocol";
import { agentConfig, privateDirectory } from "./config.js";
import { packageDirectory } from "./install/paths.js";
import { checkRunDir } from "./terminal/sessions.js";
import { ripgrepBinary, toolCommand } from "./tools.js";

type Command = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
type Check = (name: string, action: () => Promise<string>) => Promise<void>;
const gitRequirement = { file: "git", major: 2, minor: 23 };

async function checkBundledRipgrep(command: Command) {
  const identity = JSON.parse(
    await readFile(join(packageDirectory, "dist/native/identity.json"), "utf8"),
  );
  const { ripgrep } = identity;
  const line = (await command(ripgrepBinary, ["--version"])).split("\n")[0]!;
  const version = /^ripgrep (\S+)/.exec(line)?.[1];
  if (!version || version !== ripgrep?.version)
    throw new Error(`Bundled ripgrep version mismatch: ${line}`);
  return `${ripgrepBinary}; ${line}`;
}

async function checkToolVersion(
  { file, major, minor }: { file: string; major: number; minor: number },
  command: Command,
) {
  const line = (await command(file, ["--version"])).split("\n")[0]!;
  const version = /(\d+)\.(\d+)/.exec(line);
  if (
    !version ||
    Number(version[1]) < major ||
    (Number(version[1]) === major && Number(version[2]) < minor)
  )
    throw new Error(`Requires >= ${major}.${minor}.0; current: ${line}`);
  return line;
}

export async function checkWindowsShell(
  shell: string,
  command: Command = (file, args) => toolCommand(file, args, { timeout: 5000 }),
) {
  const { version, edition } = JSON.parse(
    await command(shell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition} | ConvertTo-Json -Compress",
    ]),
  ) as { version: string; edition: string };
  const match = /^(\d+)\.(\d+)\./.exec(version);
  const major = Number(match?.[1]),
    minor = Number(match?.[2]);
  if (
    !(
      (major === 5 && minor === 1 && edition === "Desktop") ||
      (major === 7 && minor >= 4 && edition === "Core")
    )
  )
    throw new Error(
      `Requires Windows PowerShell 5.1 Desktop or PowerShell 7.4 or later in the 7.x series; current: ${version} (${edition})`,
    );
  return `PowerShell ${version} (${edition})`;
}

async function checkFileHelper(path: string, command: Command) {
  try {
    await command(path, []);
  } catch (error) {
    if ((error as { code?: number }).code === 2) return "Loadable; usage exit code 2";
    throw error;
  }
  throw new Error("Helper did not return the expected usage status");
}

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
  await check(gitRequirement.file, () => checkToolVersion(gitRequirement, command));
  if (!windows)
    await check("SSH", async () => {
      await command("ssh", ["-V"]);
      return "ssh -V succeeded";
    });
  if (process.platform === "linux") await check("flock", () => command("flock", ["--version"]));
  await check("Shell", async () => {
    await access(shell, constants.X_OK);
    return windows ? `${shell}; ${await checkWindowsShell(shell, command)}` : shell;
  });
  if (!windows)
    await check("UTF-8 locale", async () => {
      try {
        const encoding = await command("locale", ["charmap"]);
        if (!/^UTF-?8$/i.test(encoding)) throw new Error(`Character map is ${encoding}`);
        return `${encoding}; LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}`;
      } catch (error) {
        throw new Error(
          `${asError(error).message}\nChoose an installed UTF-8 locale (locale -a). Current LANG=${process.env.LANG ?? ""}; LC_ALL=${process.env.LC_ALL ?? ""}; LC_CTYPE=${process.env.LC_CTYPE ?? ""}. LC_ALL overrides LC_CTYPE and LANG. Correct the launching Shell or your external process manager's environment.`,
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
      failures.push(`${name}: ${asError(error).message}`);
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
        `Setup checks failed:\n${failures.join("\n")}\nProvide Windows PowerShell 5.1 or PowerShell 7.4+ and native Git in the launching environment. Reinstall the matching complete package for bundled component failures.`,
      );
    if (macos)
      throw new Error(
        `Setup checks failed:\n${failures.join("\n")}\nProvide Git >= ${gitRequirement.major}.${gitRequirement.minor}, an executable Shell and a UTF-8 locale in the launching environment. Reinstall the matching complete package for bundled component failures.`,
      );
    throw new Error(
      `Setup checks failed:
${failures.join("\n")}
Provide ${gitRequirement.file} >= ${gitRequirement.major}.${gitRequirement.minor}.0, SSH, an executable Shell, a UTF-8 locale, infocmp and flock in the launching environment. Reinstall the matching complete package for bundled component failures.`,
    );
  }
  console.log("Setup checks passed.");
}
