import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

export const packageDirectory = resolve(import.meta.dirname, "../..");
export const installDirectory = "/opt/kiteline-agent";
export const installationUseFile = "/opt/.kiteline-agent-use.lock";
export const installationFile = "/etc/kiteline-agent.json";
export const environmentFile = "/etc/kiteline-agent.env";
export const unitName = "kiteline-agent.service";
export interface Installation {
  user: string;
  uid: number;
  gid: number;
  home: string;
}
export async function lockInstallation(mode: "shared" | "exclusive") {
  const file = await open(installationUseFile, "r");
  try {
    // flock locks the shared open file description; Node retains it after the helper exits.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", [`--${mode}`, "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", file.fd],
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              code === 1
                ? "Agent installation is in use. Stop all foreground instances, including those using custom state directories, before upgrading or uninstalling."
                : "Could not check agent installation use. Check flock (util-linux) and the installation lock file permissions.",
            ),
          );
      });
    });
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
export async function readInstallation(): Promise<Installation | undefined> {
  try {
    return JSON.parse(await readFile(installationFile, "utf8")) as Installation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function installationPaths(
  installation: Installation,
  overrides: { KITELINE_AGENT_HOME?: string; KITELINE_AGENT_RUN_DIR?: string } = {},
) {
  let environment: NodeJS.Dict<string> = {};
  try {
    const source = await readFile(environmentFile, "utf8");
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
          `${environmentFile}: ${key} must be a single-line absolute path in double quotes, for example ${key}="/var/lib/kiteline", without escapes or trailing comments`,
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dataDir = resolve(
    overrides.KITELINE_AGENT_HOME ??
      environment.KITELINE_AGENT_HOME ??
      resolve(installation.home, ".local/share/kiteline-agent"),
  );
  const runDir = resolve(
    overrides.KITELINE_AGENT_RUN_DIR ??
      environment.KITELINE_AGENT_RUN_DIR ??
      resolve(dataDir, "run"),
  );
  return { dataDir, runDir };
}
export async function installedPaths() {
  if (packageDirectory !== installDirectory) return;
  const installation = await readInstallation();
  if (!installation) return;
  if (process.getuid?.() !== installation.uid)
    throw new Error(`Use project user ${installation.user} to run this command`);
  return installationPaths(installation, {
    KITELINE_AGENT_HOME: process.env.KITELINE_AGENT_HOME,
    KITELINE_AGENT_RUN_DIR: process.env.KITELINE_AGENT_RUN_DIR,
  });
}
