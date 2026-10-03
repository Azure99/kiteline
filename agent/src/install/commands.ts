import { execFile } from "node:child_process";
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
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify, type ParseArgsOptionsConfig } from "node:util";
import { lockAgentState } from "../state-lock.js";
import { atomicJson, stateFiles } from "../config.js";
import {
  environmentFile,
  installationFile,
  installationManagementFile,
  installationPaths,
  installationUseFile,
  installDirectory,
  launcherFile,
  lockInstallation,
  lockInstallationManagement,
  packageDirectory,
  readInstallation,
  type Installation,
} from "./paths.js";

const execute = promisify(execFile);
async function exists(path: string) {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
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
async function command(file: string, args: string[], cwd?: string, input?: string) {
  const result = execute(file, args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 });
  result.child.stdin!.end(input);
  return (await result).stdout.trim();
}
async function hash(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function verifyPackage(directory: string) {
  const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  if (
    release.kind !== "agent" ||
    release.platform !== (process.platform === "darwin" ? "macos" : "linux") ||
    release.architecture !== process.arch
  )
    throw new Error("A complete agent package matching this platform and architecture is required");
  await command(
    "sh",
    [
      "-c",
      `${process.platform === "darwin" ? "/usr/bin/shasum -a 256" : "sha256sum"} -c SHA256SUMS >/dev/null`,
    ],
    directory,
  );
  if ((await command(join(directory, "runtime/bin/node"), ["--version"])) !== `v${release.node}`)
    throw new Error("Bundled Node does not match the installation manifest");
  const identity = JSON.parse(await readFile(join(directory, "dist/native/identity.json"), "utf8"));
  if ((await command(join(directory, "dist/native/bin/tmux"), ["-V"])) !== `tmux ${identity.tmux}`)
    throw new Error("Bundled tmux does not match the native identity");
  if ((await command(join(directory, "bin/kiteline-agent"), ["--version"])) !== release.version)
    throw new Error("Agent does not match the installation manifest");
  return release.version as string;
}
async function confirm(message: string, yes: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  console.log(message);
  if (yes) return;
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive confirmation is required, or explicitly pass --yes for this invocation",
    );
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  reader.once("SIGINT", () => process.emit("SIGINT"));
  try {
    if ((await reader.question("Type yes to continue: ", { signal })).trim() !== "yes")
      throw new Error("Cancelled");
  } finally {
    reader.close();
  }
}
async function account(name: string): Promise<Installation> {
  if (process.platform === "darwin") {
    const plist = await command("/usr/bin/dscl", [
      "-plist",
      "/Search",
      "-read",
      `/Users/${name}`,
      "RecordName",
      "UniqueID",
      "PrimaryGroupID",
      "NFSHomeDirectory",
    ]);
    const record = JSON.parse(
      await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], undefined, plist),
    );
    const user = record["dsAttrTypeStandard:RecordName"]?.[0];
    const uid = Number(record["dsAttrTypeStandard:UniqueID"]?.[0]);
    const gid = Number(record["dsAttrTypeStandard:PrimaryGroupID"]?.[0]);
    const home = record["dsAttrTypeStandard:NFSHomeDirectory"]?.[0];
    if (
      typeof user !== "string" ||
      !Number.isInteger(uid) ||
      !Number.isInteger(gid) ||
      typeof home !== "string" ||
      !home.startsWith("/")
    )
      throw new Error("Specify an existing project user");
    return { user, uid, gid, home };
  }
  const fields = (await command("getent", ["passwd", name])).split(":");
  const uid = Number(fields[2]),
    gid = Number(fields[3]),
    home = fields[5];
  if (
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    !home?.startsWith("/") ||
    fields.length !== 7
  )
    throw new Error("Specify an existing project user");
  return { user: fields[0]!, uid, gid, home };
}
async function stoppedInstallation(installation: Installation, purge = false) {
  const use = await lockInstallation("exclusive");
  let state: (() => Promise<void>) | undefined;
  try {
    if (purge) {
      const { dataDir } = await installationPaths(installation);
      if (await exists(dataDir)) state = await lockAgentState(dataDir);
    }
  } catch (error) {
    const errors = [error];
    await cleanup(errors, installationUseFile, () => use.close());
    throw failures("Agent state is busy or unavailable; no running tasks were stopped", errors);
  }
  return {
    stateLocked: state !== undefined,
    async close() {
      const errors: unknown[] = [];
      if (state) await cleanup(errors, "agent state lock", state);
      await cleanup(errors, installationUseFile, () => use.close());
      if (errors.length) throw failures("Installation locks could not be closed", errors);
    },
  };
}
async function writeLauncher(contents: string) {
  const temporary = `${launcherFile}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, launcherFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function replaceProgram(
  current: string,
  replacement: string,
  previous: string,
  publish: () => Promise<void>,
  restore: () => Promise<void>,
) {
  await rename(current, previous);
  try {
    await rename(replacement, current);
    await publish();
  } catch (error) {
    const errors = [error];
    await cleanup(errors, "replacement program", () =>
      rm(current, { recursive: true, force: true }),
    );
    await cleanup(errors, "previous program restore", () => rename(previous, current));
    await cleanup(errors, "previous launcher restore", restore);
    throw failures(
      errors.length === 1
        ? "Upgrade failed; the previous program was restored. No instance was started"
        : `Upgrade and recovery failed; inspect ${current} and backup location ${previous}`,
      errors,
    );
  }
}

async function installProgram(user: string, protectSignals: () => void) {
  const installation = await account(user);
  const previous = await readInstallation();
  if (previous) {
    if (previous.uid !== installation.uid)
      throw new Error(`Current installation belongs to ${previous.user}`);
    const source = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
    const installed = JSON.parse(await readFile(join(installDirectory, "release.json"), "utf8"));
    if (source.version !== installed.version)
      throw new Error(
        "A different version is installed; explicitly run kiteline-agent upgrade first",
      );
    return "The same version is already installed; the program, identity and running tasks were not changed.";
  }
  for (const path of [installDirectory, launcherFile])
    if (await exists(path)) throw new Error(`${path} already exists; verify its purpose first`);
  await verifyPackage(packageDirectory);
  protectSignals();
  try {
    await writeFile(
      environmentFile,
      `# Application directories only; background environment belongs to your process manager.\nKITELINE_AGENT_HOME=${JSON.stringify(join(installation.home, ".local/share/kiteline-agent"))}\n`,
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
  const errors: unknown[] = [];
  try {
    if (process.platform === "darwin")
      await command("/bin/cp", ["-a", "--", packageDirectory, installDirectory]);
    else await cp(packageDirectory, installDirectory, { recursive: true, verbatimSymlinks: true });
    await command("chown", ["-h", "-R", "-P", "0:0", installDirectory]);
    await command("sh", ["-c", 'umask 022; mkdir -p -- "$1"', "sh", dirname(launcherFile)]);
    await atomicJson(installationFile, installation);
    await chmod(installationFile, 0o644);
    await writeLauncher(
      await readFile(join(installDirectory, "bin/kiteline-agent-installed"), "utf8"),
    );
  } catch (error) {
    errors.push(error);
    for (const path of [launcherFile, installationFile, installDirectory])
      await cleanup(errors, path, () => rm(path, { recursive: true, force: true }));
  }
  if (errors.length) throw failures("Installation did not complete", errors);
  return `Installed but not started. As ${installation.user}, run kiteline-agent bind --server <http-or-https-origin>, then kiteline-agent run.\nApplication directories: ${environmentFile}`;
}

async function upgrade(
  installation: Installation,
  archive: string,
  yes: boolean,
  protectSignals: () => void,
  signal: AbortSignal,
) {
  await (await stoppedInstallation(installation)).close();
  const source = resolve(archive);
  const temporary = await mkdtemp(join(dirname(installDirectory), ".kiteline-upgrade-"));
  const replacement = join(temporary, "new"),
    previous = join(temporary, "previous");
  const path = join(temporary, "input.tar.gz");
  let use: Awaited<ReturnType<typeof stoppedInstallation>> | undefined;
  let completion: string | undefined;
  const errors: unknown[] = [];
  try {
    const checksum = (await readFile(source + ".sha256", "utf8")).trim().split(/\s+/)[0];
    await cp(source, path);
    signal.throwIfAborted();
    if (
      !checksum ||
      !/^[a-f0-9]{64}$/i.test(checksum) ||
      (await hash(path)) !== checksum.toLowerCase()
    )
      throw new Error("Package SHA256 verification failed");
    await mkdir(replacement, { mode: 0o755 });
    await chmod(replacement, 0o755);
    await command("tar", [
      "-xpzf",
      path,
      "--strip-components=1",
      "--no-same-owner",
      "-C",
      replacement,
    ]);
    signal.throwIfAborted();
    const version = await verifyPackage(replacement);
    const newLauncher = await readFile(join(replacement, "bin/kiteline-agent-installed"), "utf8");
    const oldLauncher = await readFile(launcherFile, "utf8");
    await confirm(
      `Install version ${version}, retaining binding, configuration, workspaces and task data? No instance will be started. Coordinate external restart policies before continuing.`,
      yes,
      signal,
    );
    protectSignals();
    use = await stoppedInstallation(installation);
    await command("chown", ["-h", "-R", "-P", "0:0", replacement]);
    await replaceProgram(
      installDirectory,
      replacement,
      previous,
      () => writeLauncher(newLauncher),
      () => writeLauncher(oldLauncher),
    );
    completion = `Upgraded to ${version}; not started. Run kiteline-agent run as ${installation.user}, or start it using your external manager.`;
    await rm(previous, { recursive: true });
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(errors, temporary, async () => {
      if (await exists(previous))
        console.error(
          completion
            ? `Upgrade is applied; backup cleanup is incomplete at ${previous}`
            : `Previous program backup retained at ${previous}`,
        );
      else await rm(temporary, { recursive: true, force: true });
    });
    if (use) await cleanup(errors, installationUseFile, () => use!.close());
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
  signal: AbortSignal,
) {
  await (await stoppedInstallation(installation, purge)).close();
  const { dataDir } = await installationPaths(installation);
  await confirm(
    `Remove the agent program? ${purge ? `Delete its state JSON and tasks at ${dataDir}.` : `Retain state and tasks at ${dataDir}.`} Workspaces and external manager configuration are not removed.`,
    yes,
    signal,
  );
  protectSignals();
  const use = await stoppedInstallation(installation, purge);
  const purgePaths =
    purge && use.stateLocked
      ? [
          stateFiles.metadata,
          stateFiles.connection,
          stateFiles.config,
          stateFiles.temporaryFiles,
          stateFiles.tasks,
        ].map((name) => join(dataDir, name))
      : [];
  const errors: unknown[] = [];
  try {
    await rm(launcherFile, { force: true });
    await rm(installDirectory, { recursive: true, force: true });
    for (const path of purgePaths)
      await rm(path, { force: true, recursive: path === join(dataDir, stateFiles.tasks) });
    await rm(installationFile, { force: true });
  } catch (error) {
    errors.push(error);
    console.error(
      `Uninstall is incomplete. Inspect ${installDirectory}, ${launcherFile}, ${installationFile} and ${dataDir}.`,
    );
  } finally {
    await cleanup(errors, installationUseFile, () => use.close());
  }
  if (errors.length) throw failures("Uninstall did not complete", errors);
  return `Uninstalled; ${purge && use.stateLocked ? "application state removed" : "state retained"}. External manager configuration was not changed. Application directory configuration was not removed: ${environmentFile}. Stable installation lock files were not removed: ${installationUseFile}, ${installationManagementFile}.`;
}

export async function installCli(action: string, args: string[]) {
  if (process.platform === "win32")
    throw new Error("Use the public kiteline-agent.ps1 launcher for Windows installation changes");
  const options: ParseArgsOptionsConfig =
    action === "install"
      ? { user: { type: "string" as const } }
      : action === "upgrade"
        ? { archive: { type: "string" as const }, yes: { type: "boolean" as const } }
        : { "purge-state": { type: "boolean" as const }, yes: { type: "boolean" as const } };
  const { values } = parseArgs({ args, options });
  if (action === "install" && !values.user)
    throw new Error("Usage: kiteline-agent install --user PROJECT_USER");
  if (action === "upgrade" && !values.archive)
    throw new Error("Usage: kiteline-agent upgrade --archive RELEASE.tar.gz [--yes]");
  if (process.getuid?.() !== 0)
    throw new Error("Installation changes require sudo or root; run the agent as the project user");
  if (packageDirectory === installDirectory)
    throw new Error("Use the public kiteline-agent launcher for installation changes");
  await command("sh", ["-c", 'umask 022; mkdir -p -- "$1"', "sh", dirname(installDirectory)]);
  const management = await lockInstallationManagement();
  const errors: unknown[] = [];
  let completion: string | undefined;
  let protectedSignals = false;
  const cancellation = new AbortController();
  const handlers = Object.entries({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }).map(
    ([signal, code]) => ({
      signal: signal as NodeJS.Signals,
      handler: () => {
        process.exitCode = code;
        if (!protectedSignals) cancellation.abort(new Error(`${signal}: cancelled`));
        console.error(
          protectedSignals
            ? `${signal} received; finishing installation changes and cleanup before exit.`
            : `${signal} received; cancelling preparation and cleaning up before exit.`,
        );
      },
    }),
  );
  const protectSignals = () => {
    cancellation.signal.throwIfAborted();
    if (protectedSignals) return;
    protectedSignals = true;
  };
  for (const { signal, handler } of handlers) process.on(signal, handler);
  try {
    if (action === "install")
      completion = await installProgram(values.user as string, protectSignals);
    else {
      const installation = await readInstallation();
      if (!installation) throw new Error("kiteline-agent is not installed");
      completion =
        action === "upgrade"
          ? await upgrade(
              installation,
              values.archive as string,
              !!values.yes,
              protectSignals,
              cancellation.signal,
            )
          : await uninstall(
              installation,
              !!values["purge-state"],
              !!values.yes,
              protectSignals,
              cancellation.signal,
            );
    }
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(errors, installationManagementFile, () => management.close());
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
  if (errors.length)
    throw failures(
      completion ? `${completion} Cleanup failed` : "Installation management failed",
      errors,
    );
  cancellation.signal.throwIfAborted();
  if (completion) console.log(completion);
}
