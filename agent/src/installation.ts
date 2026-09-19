import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

export const packageDirectory = resolve(import.meta.dirname, "../..");
export const installDirectory = "/opt/kiteline-agent";
export const installationFile = "/etc/kiteline-agent.json";
export const environmentFile = "/etc/kiteline-agent.env";
export const unitName = "kiteline-agent.service";
export interface Installation {
  user: string;
  uid: number;
  gid: number;
  home: string;
}
export async function readInstallation(): Promise<Installation | undefined> {
  try {
    return JSON.parse(await readFile(installationFile, "utf8")) as Installation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function installationPaths(installation: Installation) {
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
          `${environmentFile}: ${key} 必须为单行双引号绝对路径，例如 ${key}="/var/lib/kiteline"，不使用转义或尾部注释`,
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    dataDir:
      environment.KITELINE_AGENT_HOME ?? resolve(installation.home, ".local/share/kiteline-agent"),
    runDir: environment.KITELINE_AGENT_RUN_DIR ?? "/run/kiteline-agent",
  };
}
export async function installedPaths() {
  if (packageDirectory !== installDirectory) return;
  const installation = await readInstallation();
  if (!installation) return;
  if (process.getuid?.() !== installation.uid)
    throw new Error(`请以项目用户 ${installation.user} 执行此命令`);
  return installationPaths(installation);
}
