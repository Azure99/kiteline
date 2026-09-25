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
import type { RpcResult } from "@kiteline/shared/protocol";
import { localRequest } from "./local.js";
import { atomicJson } from "./config.js";
import {
  environmentFile,
  installationFile,
  installationPaths,
  installationUseFile,
  InstallationLockCloseError,
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
  try {
    await stopped(installation);
    return lock;
  } catch (error) {
    try {
      await lock.close();
    } catch (cleanupError) {
      throw new InstallationLockCloseError([error, cleanupError]);
    }
    throw error;
  }
}
function failures(message: string, errors: unknown[]) {
  return new AggregateError(errors, `${message}: ${errors.map(String).join("; ")}`);
}
async function cleanup(errors: unknown[], resource: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    errors.push(new Error(`Could not clean up ${resource}: ${String(error)}`, { cause: error }));
  }
}
async function unitIs(state: "active" | "enabled") {
  if (!(await exists(unitFile))) return false;
  if (state === "enabled") {
    const value = await enabledState();
    return value === "enabled" || value === "enabled-runtime";
  }
  // show loads an inactive unit that older systemd may have already unloaded.
  const output = await command("systemctl", [
    "show",
    "--property=LoadState",
    "--property=ActiveState",
    unitName,
  ]);
  const { LoadState, ActiveState } = Object.fromEntries(
    output.split("\n").map((line) => line.split("=")),
  );
  if (LoadState === "loaded") {
    if (ActiveState === "active") return true;
    if (["inactive", "failed", "activating", "deactivating", "reloading"].includes(ActiveState))
      return false;
  }
  throw new Error(`Could not determine service state: ${output}`);
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
  await command("sh", ["-c", "sha256sum -c SHA256SUMS >/dev/null"], directory);
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
  // Only the target-user bootstrap receives the service environment.
  const check = execute(
    "runuser",
    [
      "-u",
      installation.user,
      "--",
      join(installDirectory, "runtime/bin/node"),
      "-e",
      `const env = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const result = require("node:child_process").spawnSync(process.argv[1], ["check"], {
  env, stdio: ["ignore", "inherit", "inherit"],
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;`,
      launcher,
    ],
    { encoding: "utf8", maxBuffer: 128 * 1024 },
  );
  let inputError: Error | undefined;
  check.child.stdin?.on("error", (error: Error) => {
    inputError = error;
  });
  check.child.stdin?.end(JSON.stringify(env));
  await check;
  if (inputError) throw inputError;
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
async function installProgram(user: string, service: boolean, protectSignals: () => void) {
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
    return "System service is enabled but not started. Run sudo kiteline-agent service start.";
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
  protectSignals();
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
    await command("chown", ["-h", "-R", "-P", "0:0", "--", installDirectory]);
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
    const errors = [error];
    if (service)
      await cleanup(errors, "service enablement", () =>
        command("systemctl", ["disable", unitName]),
      );
    for (const path of [launcher, unitFile, installationFile, installDirectory])
      await cleanup(errors, path, () => rm(path, { recursive: true, force: true }));
    if (service)
      await cleanup(errors, "systemd unit cache", () => command("systemctl", ["daemon-reload"]));
    throw failures("Installation failed", errors);
  }
  return `Installed but not started. As ${installation.user}, run kiteline-agent bind --server <http-or-https-origin>, then ${service ? "sudo kiteline-agent service start" : "kiteline-agent run"}.
Environment configuration: ${environmentFile}`;
}
async function manageInstallation(action: (protectSignals: () => void) => Promise<string | void>) {
  await mkdir("/opt", { recursive: true });
  const release = await lockfile.lock("/opt", {
    lockfilePath: "/opt/.kiteline-agent-install.lock",
    realpath: false,
  });
  const errors: unknown[] = [];
  let completion: string | void = undefined;
  let protectedSignals = false;
  let interrupted = false;
  const handlers = Object.entries({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }).map(
    ([signal, code]) => ({
      signal: signal as NodeJS.Signals,
      handler: () => {
        if (interrupted) return;
        interrupted = true;
        process.exitCode = code;
        console.error(
          `${signal} received; finishing installation changes and cleanup before exit.`,
        );
      },
    }),
  );
  const protectSignals = () => {
    if (protectedSignals) return;
    protectedSignals = true;
    for (const { signal, handler } of handlers) process.on(signal, handler);
  };
  try {
    completion = await action(protectSignals);
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(errors, "/opt/.kiteline-agent-install.lock", release);
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
  if (errors.length)
    throw failures(
      completion
        ? `${completion} Installation lock cleanup failed`
        : "Installation management failed",
      errors,
    );
  if (completion) console.log(completion);
}
async function install(user: string, service: boolean) {
  await manageInstallation((protectSignals) => installProgram(user, service, protectSignals));
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
async function enabledState() {
  try {
    return await command("systemctl", ["is-enabled", unitName]);
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout?: string };
    if ([1, 3, 4].includes(code) && stdout?.trim() === "disabled") return "disabled";
    throw error;
  }
}
async function reportServiceState() {
  try {
    if (!(await exists(unitFile))) return "No system service unit.";
    return `Service active=${await unitIs("active")}, enabled=${await enabledState()}.`;
  } catch (error) {
    return `Service state could not be read: ${String(error)}`;
  }
}
async function restoreService(installation: Installation, active: boolean, enabled?: string) {
  const errors: unknown[] = [];
  if (enabled !== undefined) {
    try {
      if ((await enabledState()) !== enabled) {
        await command("systemctl", ["disable", unitName]);
        if (enabled === "enabled" || enabled === "enabled-runtime")
          await command("systemctl", [
            "enable",
            ...(enabled === "enabled-runtime" ? ["--runtime"] : []),
            unitName,
          ]);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    if ((await unitIs("active")) !== active)
      await command("systemctl", [active ? "start" : "stop", unitName]);
  } catch (error) {
    errors.push(error);
  }
  if (active) {
    try {
      await waitReady(installation);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw failures("Service state restoration was incomplete", errors);
}
async function upgrade(
  installation: Installation,
  archive: string,
  yes: boolean,
  protectSignals: () => void,
) {
  const runningService = await unitIs("active");
  if (!runningService) await (await installationStopped(installation)).close();
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
  let useLock: Awaited<ReturnType<typeof installationStopped>> | undefined;
  let lockCloseFailed = false;
  let startAttempted = false;
  let completion: string | undefined;
  const errors: unknown[] = [];
  async function closeUseLock() {
    try {
      await useLock?.close();
      useLock = undefined;
    } catch (error) {
      lockCloseFailed = true;
      throw error;
    }
  }
  try {
    await mkdir(replacement);
    await chmod(replacement, 0o755);
    await command("tar", [
      "-xzf",
      path,
      "--strip-components=1",
      "--no-same-owner",
      "-C",
      replacement,
    ]);
    const version = await verifyPackage(replacement);
    if (runningService) {
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
      try {
        let offset = 0,
          active = 0;
        while (true) {
          const response = JSON.parse(
            await command("runuser", [
              "-u",
              installation.user,
              "--",
              "env",
              "-u",
              "KITELINE_AGENT_HOME",
              "-u",
              "KITELINE_AGENT_RUN_DIR",
              launcher,
              "schedule",
              "list",
              "--offset",
              String(offset),
              "--json",
            ]),
          ) as { result: RpcResult<"tasks.list"> };
          for (const task of response.result.items) {
            if (!task.currentRun) continue;
            active++;
            console.log(
              `Scheduled task ${task.id} (${task.name}): run=${task.currentRun.id}; state=${task.currentRun.state}`,
            );
          }
          offset += response.result.items.length;
          if (!response.result.items.length || offset >= response.result.total) break;
        }
        if (!active) console.log("No active scheduled runs.");
      } catch {
        console.log("Could not read scheduled runs; their current state is unknown.");
      }
    }
    await confirm(
      `Upgrading to ${version} will end all terminals and in-flight scheduled runs while preserving the binding, configuration, workspaces, scheduled task definitions and retained results.`,
      yes,
    );
    protectSignals();
    try {
      if (runningService) await command("systemctl", ["stop", unitName]);
      useLock = await installationStopped(installation);
      await rename(installDirectory, previous);
      keepPrevious = true;
      await rename(replacement, installDirectory);
      if (hasUnit) await writeUnit(installation);
      await closeUseLock();
      if (restartService) {
        startAttempted = true;
        await command("systemctl", ["start", unitName]);
        await waitReady(installation);
      }
    } catch (error) {
      const recoveryErrors = [error];
      try {
        if (lockCloseFailed || error instanceof InstallationLockCloseError)
          throw new Error(
            "Installation lock close failed; lock ownership is unknown. Program trees are retained without starting the service.",
            { cause: error },
          );
        if (keepPrevious) {
          if (startAttempted) await command("systemctl", ["stop", unitName]);
          useLock ??= await installationStopped(installation);
          await rm(installDirectory, { recursive: true, force: true });
          await rename(previous, installDirectory);
          keepPrevious = false;
          if (hasUnit) await writeUnit(installation);
        }
        await closeUseLock();
        if (hasUnit) await restoreService(installation, runningService);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
      throw failures(
        `${recoveryErrors.length === 1 ? "Upgrade failed; the previous installation and service state have been restored" : "Upgrade failed and recovery also failed"}. Stopped terminals and scheduled runs cannot be resumed. ${await reportServiceState()}`,
        recoveryErrors,
      );
    }
    keepPrevious = false;
    completion = `Upgraded to ${version}. ${restartService ? "Service started; previous terminals and scheduled runs have ended. Scheduled task definitions and retained results are preserved." : "Not started; run kiteline-agent run as the project user."}`;
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(errors, installationUseFile, closeUseLock);
    if (keepPrevious)
      console.error(
        `Previous installation is retained at ${previous}; restore it and check the service.`,
      );
    else await cleanup(errors, temporary, () => rm(temporary, { recursive: true, force: true }));
  }
  if (errors.length)
    throw failures(
      completion ? `${completion} Cleanup failed` : "Upgrade did not complete",
      errors,
    );
  return completion;
}
async function uninstall(
  installation: Installation,
  purge: boolean,
  yes: boolean,
  protectSignals: () => void,
) {
  const hasUnit = await exists(unitFile);
  const runningService = await unitIs("active");
  const enabledService = hasUnit ? await enabledState() : undefined;
  if (!runningService) await (await installationStopped(installation)).close();
  const paths = await installationPaths(installation);
  const tasksDirectory = join(paths.dataDir, "tasks");
  const purgePaths = purge
    ? ["agent.json", "connection.json", "config.json", "temporary-files.json", "tasks"].map(
        (name) => join(paths.dataDir, name),
      )
    : [];
  await confirm(
    `Uninstalling will end all terminals and in-flight scheduled runs and remove the program. ${purge ? `Also delete agent state, scheduled task definitions and retained results at ${paths.dataDir}.` : `Retain state, scheduled task definitions and results at ${paths.dataDir}.`}`,
    yes,
  );
  let useLock: Awaited<ReturnType<typeof installationStopped>> | undefined;
  const errors: unknown[] = [];
  let completion: string | undefined;
  protectSignals();
  try {
    if (hasUnit) await command("systemctl", ["disable", "--now", unitName]);
    useLock = await installationStopped(installation);
  } catch (error) {
    errors.push(error);
    try {
      if (error instanceof InstallationLockCloseError)
        throw new Error("Installation lock ownership is unknown; the service was not restarted.", {
          cause: error,
        });
      if (hasUnit) await restoreService(installation, runningService, enabledService);
    } catch (recoveryError) {
      errors.push(recoveryError);
    }
    throw failures(
      `Uninstall failed before removing the program. ${await reportServiceState()}`,
      errors,
    );
  }
  try {
    await rm(unitFile, { force: true });
    await rm(launcher, { force: true });
    await rm(installDirectory, { recursive: true });
    await rm(installationFile, { force: true });
    if (hasUnit) await command("systemctl", ["daemon-reload"]);
    for (const path of purgePaths)
      await rm(path, { force: true, recursive: path === tasksDirectory });
    completion = `Uninstalled; ${purge ? "agent state removed" : "state and environment configuration retained"}.`;
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(errors, installationUseFile, () => useLock.close());
  }
  if (errors.length) {
    for (const path of [
      installDirectory,
      launcher,
      unitFile,
      installationFile,
      paths.dataDir,
      ...purgePaths,
    ]) {
      try {
        console.error(`${path} present=${await exists(path)}`);
      } catch (inspectionError) {
        errors.push(inspectionError);
      }
    }
    console.error(`State directory: ${paths.dataDir}. ${await reportServiceState()}`);
    throw failures(
      completion ? `${completion} Cleanup failed` : "Uninstall did not complete",
      errors,
    );
  }
  return completion;
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
  await manageInstallation(async (protectSignals) => {
    const installation = await readInstallation();
    if (!installation) throw new Error("kiteline-agent is not installed");
    if (action === "check") {
      if (installation.uid === 0)
        throw new Error("System service requires a non-root project user");
      await checkServiceEnvironment(installation);
      return "Service environment checks passed.";
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
      return "Service startup at boot is disabled. Run kiteline-agent run as the project user to run in the foreground.";
    } else if (action === "upgrade") {
      if (!values.archive)
        throw new Error("Usage: kiteline-agent service upgrade --archive RELEASE.tar.gz [--yes]");
      return upgrade(installation, values.archive, values.yes, protectSignals);
    } else if (action === "uninstall")
      return uninstall(installation, values["purge-state"], values.yes, protectSignals);
    else
      throw new Error(
        "Usage: kiteline-agent service install/check/start/status/logs/stop/disable/upgrade/uninstall",
      );
  });
}
