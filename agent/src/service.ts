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
  installationUseFile,
  installDirectory,
  lockInstallation,
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
    throw new Error(
      "Agent is still running. Stop the foreground process or run service stop first; this operation has not ended existing tasks.",
    );
}
async function installationStopped(installation: Installation) {
  const lock = await lockInstallation("exclusive");
  await lock.close();
  await stopped(installation);
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
    throw new Error("A complete agent package matching the current Linux architecture is required");
  await command("sha256sum", ["--status", "--check", "SHA256SUMS"], directory);
  if ((await command(join(directory, "runtime/bin/node"), ["--version"])) !== `v${release.node}`)
    throw new Error("Bundled Node does not match the installation manifest");
  if (
    (await command(join(directory, "dist/native/bin/tmux"), ["-V"])) !==
    `tmux ${release.native.tmux}`
  )
    throw new Error("Bundled tmux does not match the installation manifest");
  if ((await command(join(directory, "bin/kiteline-agent"), ["--version"])) !== release.version)
    throw new Error("Agent does not match the installation manifest");
  return release.version as string;
}
async function confirm(message: string, yes: boolean) {
  console.log(message);
  if (yes) return;
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive confirmation is required, or explicitly pass --yes for this invocation",
    );
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await reader.question("Type yes to continue: ")).trim() !== "yes")
      throw new Error("Cancelled");
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
    throw new Error(
      service ? "Specify an existing non-root project user" : "Specify an existing project user",
    );
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
    if (!service)
      throw new Error("Program is already installed; explicitly use service upgrade to upgrade");
    if (previous.uid !== installation.uid)
      throw new Error(`Current installation belongs to ${previous.user}`);
    if ((await verifyPackage(packageDirectory)) !== (await verifyPackage(installDirectory)))
      throw new Error("A different version is installed; explicitly run service upgrade first");
    await stopped(previous);
    await checkServiceEnvironment(previous);
    await writeUnit(previous);
    await command("systemctl", ["enable", unitName]);
    console.log(
      "System service is enabled but not started. Run sudo kiteline-agent service start.",
    );
    return;
  }
  for (const path of [installDirectory, unitFile, launcher]) {
    try {
      await lstat(path);
      throw new Error(`${path} already exists; verify its purpose first`);
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
      `# Directory values: double-quoted absolute paths, without escapes.\nKITELINE_AGENT_HOME=${JSON.stringify(join(installation.home, ".local/share/kiteline-agent"))}\n`,
      { flag: "wx", mode: 0o640 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chown(environmentFile, 0, installation.gid);
  await chmod(environmentFile, 0o640);
  await installationPaths(installation);
  await writeFile(installationUseFile, "", { flag: "a", mode: 0o640 });
  await chown(installationUseFile, 0, installation.gid);
  await chmod(installationUseFile, 0o640);
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
    `Installed but not started. As ${installation.user}, run kiteline-agent bind --server <http-or-https-origin>, then ${service ? "sudo kiteline-agent service start" : "kiteline-agent run"}.
Environment configuration: ${environmentFile}`,
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
  if (process.getuid?.() !== 0)
    throw new Error(
      "Installation requires sudo or root; run as the project user after installation",
    );
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
  throw new Error("Service could not complete local RPC initialization");
}
async function upgrade(installation: Installation, archive: string, yes: boolean) {
  const runningService = await unitIs("active");
  if (!runningService) await installationStopped(installation);
  const restartService = runningService || (await unitIs("enabled"));
  const hasUnit = await exists(unitFile);
  const path = resolve(archive);
  const checksum = (await readFile(path + ".sha256", "utf8")).trim().split(/\s+/)[0];
  if (!checksum || (await hash(path)) !== checksum)
    throw new Error("Package SHA256 verification failed");
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
      console.log(sessions || "No active terminals.");
    } catch {
      console.log("Could not read current sessions; the service may still have active tasks.");
    }
    await confirm(
      `Upgrading to ${version} will end all terminal tasks for this agent while preserving the binding, configuration, and workspaces.`,
      yes,
    );
    if (runningService) await command("systemctl", ["stop", unitName]);
    await installationStopped(installation);
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
      throw new Error(
        "Upgrade failed; the complete previous installation has been restored, but the original terminals have ended. Check service status/logs.",
        {
          cause: error,
        },
      );
    }
    keepPrevious = false;
    console.log(
      `Upgraded to ${version}. ${restartService ? "Service started; the original terminals have ended." : "Not started; run kiteline-agent run as the project user."}`,
    );
  } finally {
    if (keepPrevious)
      console.error(
        `Previous installation is retained at ${previous}; restore it and check the service.`,
      );
    else await rm(temporary, { recursive: true, force: true });
  }
}
async function uninstall(installation: Installation, purge: boolean, yes: boolean) {
  if (!(await unitIs("active"))) await installationStopped(installation);
  const hasUnit = await exists(unitFile);
  const paths = await installationPaths(installation);
  await confirm(
    `Uninstalling will end all terminals and remove the program. ${purge ? `Also delete state at ${paths.dataDir}.` : `Retain state at ${paths.dataDir}.`}`,
    yes,
  );
  if (hasUnit) await command("systemctl", ["disable", "--now", unitName]);
  await installationStopped(installation);
  await rm(unitFile, { force: true });
  await rm(launcher, { force: true });
  await rm(installDirectory, { recursive: true });
  await rm(installationFile, { force: true });
  if (hasUnit) await command("systemctl", ["daemon-reload"]);
  if (purge)
    for (const name of ["agent.json", "connection.json", "config.json", "temporary-files.json"])
      await rm(join(paths.dataDir, name), { force: true });
  console.log(
    `Uninstalled; ${purge ? "agent state removed" : "state and environment configuration retained"}.`,
  );
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
  if (process.getuid?.() !== 0)
    throw new Error(
      "Service installation, starting, stopping, upgrading, and uninstallation require sudo or root",
    );
  if (action === "install") {
    if (!values.user) throw new Error("Usage: kiteline-agent service install --user PROJECT_USER");
    await install(values.user, true);
    return;
  }
  const installation = await readInstallation();
  if (!installation) throw new Error("kiteline-agent is not installed");
  if (action === "check") {
    if (installation.uid === 0) throw new Error("System service requires a non-root project user");
    await checkServiceEnvironment(installation);
    console.log("Service environment checks passed.");
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
    console.log(
      "Service startup at boot is disabled. Run kiteline-agent run as the project user to run in the foreground.",
    );
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
