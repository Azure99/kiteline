import { spawn } from "node:child_process";
import { closeSync, fstatSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { asError } from "@kiteline/shared/protocol";
import { nativeDirectory, resourceDirectory } from "@kiteline/shared/node/paths";
import { windowsNative } from "@kiteline/shared/windows/native";
import { unixInstallationLayout, windowsInstallationLayout } from "./layout.js";

export interface Installation {
  user: string;
  uid: number;
  gid: number;
  home: string;
}
export async function lockFileDescriptor(fd: number) {
  const flock = process.platform === "darwin" ? resolve(nativeDirectory, "bin/flock") : "flock";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(flock, ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            code === 1
              ? "Agent installation is busy. Stop all users of the installation and coordinate external restart policies before changing it."
              : "Could not lock the agent installation. Check flock and lock file permissions.",
          ),
        );
    });
  });
}
export async function lockInstallation() {
  const file = await open(unixInstallationLayout.useFile, "r");
  try {
    // flock locks the shared open file description; Node retains it after the helper exits.
    await lockFileDescriptor(file.fd);
    return file;
  } catch (error) {
    try {
      await file.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Installation lock acquisition and close failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
export async function lockInstallationManagement() {
  const expected = await stat(unixInstallationLayout.managementFile).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  let inherited;
  try {
    inherited = fstatSync(unixInstallationLayout.managementLockFd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
  if (expected && inherited?.dev === expected.dev && inherited.ino === expected.ino) {
    return { close: async () => closeSync(unixInstallationLayout.managementLockFd) };
  }
  throw new Error("Management lock was not inherited; use the public kiteline-agent launcher");
}
export async function readInstallation(): Promise<Installation | undefined> {
  try {
    const value = JSON.parse(await readFile(unixInstallationLayout.recordFile, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.user !== "string" ||
      !value.user ||
      !Number.isSafeInteger(value.uid) ||
      value.uid < 0 ||
      !Number.isSafeInteger(value.gid) ||
      value.gid < 0 ||
      typeof value.home !== "string" ||
      !isAbsolute(value.home)
    )
      throw new Error("Invalid installation record");
    return value as Installation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`${unixInstallationLayout.recordFile}: ${asError(error).message}`, {
        cause: error,
      });
  }
}
export function applicationPaths(home: string, dataOverride?: string, runOverride?: string) {
  const dataDir = resolve(dataOverride ?? resolve(home, ".local/share/kiteline-agent"));
  return { dataDir, runDir: resolve(runOverride ?? resolve(dataDir, "run")) };
}
export async function installationPaths(
  installation: Installation,
  overrides: { KITELINE_AGENT_HOME?: string; KITELINE_AGENT_RUN_DIR?: string } = {},
) {
  let environment: NodeJS.Dict<string> = {};
  try {
    const source = await readFile(unixInstallationLayout.environmentFile, "utf8");
    environment = parseEnv(source);
    for (const key of ["KITELINE_AGENT_HOME", "KITELINE_AGENT_RUN_DIR"]) {
      if (environment[key] === undefined) continue;
      const assignments = source
        .split(/\r?\n/)
        .filter((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
      if (
        assignments.length !== 1 ||
        !new RegExp(`^${key}="/[^"\\\\]*"$`).test(assignments[0]!) ||
        !isAbsolute(environment[key]!)
      )
        throw new Error(
          `${unixInstallationLayout.environmentFile}: ${key} must be a single-line absolute path in double quotes, for example ${key}="/var/lib/kiteline", without escapes or trailing comments`,
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return applicationPaths(
    installation.home,
    overrides.KITELINE_AGENT_HOME ?? environment.KITELINE_AGENT_HOME,
    overrides.KITELINE_AGENT_RUN_DIR ?? environment.KITELINE_AGENT_RUN_DIR,
  );
}
export async function installedPaths() {
  if (process.platform === "win32") {
    const directories = windowsNative().installationDirectories();
    const programDirectory = resolve(
      directories.programFiles,
      windowsInstallationLayout.directoryName,
    );
    if (resourceDirectory.toLowerCase() !== programDirectory.toLowerCase()) return;
    const installationFile = resolve(
      directories.programData,
      windowsInstallationLayout.directoryName,
      windowsInstallationLayout.recordFile,
    );
    const installation = JSON.parse(await readFile(installationFile, "utf8"));
    if (windowsNative().identity().sid !== installation.sid)
      throw new Error(`Use project user ${installation.user} to run this command`);
    const values = {
      dataDir: process.env.KITELINE_AGENT_HOME ?? installation.dataDir,
      runDir: process.env.KITELINE_AGENT_RUN_DIR ?? installation.runDir,
    };
    for (const [name, value] of Object.entries(values))
      if (typeof value !== "string" || !isAbsolute(value))
        throw new Error(`Broken installation: ${name} must be an absolute Windows path`);
    return { dataDir: resolve(values.dataDir), runDir: resolve(values.runDir) };
  }
  if (resourceDirectory !== unixInstallationLayout.directory) return;
  const installation = await readInstallation();
  if (!installation)
    throw new Error(`Broken installation: ${unixInstallationLayout.recordFile} is missing`);
  if (process.getuid?.() !== installation.uid)
    throw new Error(`Use project user ${installation.user} to run this command`);
  return installationPaths(installation, {
    KITELINE_AGENT_HOME: process.env.KITELINE_AGENT_HOME,
    KITELINE_AGENT_RUN_DIR: process.env.KITELINE_AGENT_RUN_DIR,
  });
}
