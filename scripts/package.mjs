import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { buildLinuxComponents } from "./build-linux-components.mjs";
import { verifyWindowsComponents } from "./build-windows-components.mjs";
import { verifyMacosComponents } from "./build-macos-components.mjs";
import {
  agentTargets as allAgentTargets,
  executablePathPattern,
  expectedRelease,
  packageNames,
  releaseMatches,
  serverArchitectures,
  sourceCommit as readSourceCommit,
} from "./release-artifacts.mjs";
import {
  capture as captureOutput,
  componentPackagePath,
  digest,
  fetchPinned,
  nodeInput,
  releaseCache,
  run as execute,
  staticNodeInput,
} from "./release-inputs.mjs";
import { windowsRuntimeFiles } from "./windows-components.ts";
import { agentLauncher, windowsAgentLaunchers, windowsCliLauncher } from "./agent-launcher.ts";
import { terminalReset } from "../packages/cli/src/terminal-reset.ts";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(join(root, "release/inputs.json"), "utf8"));
assert.equal(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node,
  release.node.version,
  "package.json engines.node and release/inputs.json node.version must pin the same version",
);
const { version } = JSON.parse(
  readFileSync(join(root, "packages/shared/src/version.json"), "utf8"),
);
const output = join(root, "dist/releases");

function run(command, args, options = {}) {
  return execute(command, args, { cwd: root, ...options });
}
function capture(command, args) {
  return captureOutput(command, args, { cwd: root });
}

function compileProjects(projects) {
  for (const name of projects)
    rmSync(join(root, "packages", name, "dist"), { recursive: true, force: true });
  run("pnpm", ["exec", "tsc", "-b", ...projects.map((name) => `packages/${name}`)]);
}

function createPackageDirectory(name, scratch) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  cpSync(join(root, "LICENSE"), join(directory, "LICENSE"));
  return directory;
}

function deployProductionPackage(name, directory, platform) {
  run("pnpm", [
    "--filter",
    `@kiteline/${name}`,
    "deploy",
    "--prod",
    "--config.inject-workspace-packages=true",
    `--config.node-linker=${platform === "windows" ? "hoisted" : "isolated"}`,
    directory,
  ]);
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "node_modules/.pnpm/lock.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.package-map.json",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
  ])
    rmSync(join(directory, path), { recursive: true, force: true });
}

function setSharedResourceRoot(directory) {
  const manifest = join(directory, "package.json");
  const metadata = JSON.parse(readFileSync(manifest, "utf8"));
  // Source resources sit above packages; release resources share the component parent.
  metadata.kitelineResourceRoot = "..";
  writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n");
}

function connectSharedPackage(directory, platform, { deployed }) {
  const link = join(directory, "node_modules/@kiteline/shared");
  // Isolated pnpm deploy owns an injected package directory; copied CLI has no dependency tree.
  const injectedDirectory =
    deployed && platform !== "windows" ? resolve(realpathSync(link), "../../..") : undefined;
  rmSync(link, { recursive: true, force: true });
  if (platform === "windows") {
    mkdirSync(link, { recursive: true });
    const { exports } = JSON.parse(
      readFileSync(join(root, "packages/shared/package.json"), "utf8"),
    );
    const forwarding = {};
    for (const [index, [key, source]] of Object.entries(exports).entries()) {
      const name = `export-${index}.js`;
      writeFileSync(join(link, name), `export * from "../../../../shared/${source.slice(2)}";\n`);
      forwarding[key] = `./${name}`;
    }
    writeFileSync(
      join(link, "package.json"),
      JSON.stringify({
        name: "@kiteline/shared",
        license: "Apache-2.0",
        type: "module",
        exports: forwarding,
      }) + "\n",
    );
  } else {
    mkdirSync(join(directory, "node_modules/@kiteline"), { recursive: true });
    symlinkSync("../../../shared", link);
    if (injectedDirectory) rmSync(injectedDirectory, { recursive: true, force: true });
  }
  const manifest = join(directory, "package.json");
  const metadata = JSON.parse(readFileSync(manifest, "utf8"));
  metadata.dependencies["@kiteline/shared"] = "file:../shared";
  writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n");
}

function prepareAgentComponents(target, scratch) {
  if (target.platform === "linux") {
    const componentsDirectory = join(scratch, "linux");
    buildLinuxComponents(componentsDirectory, target.architecture);
    return {
      runtimeDirectory: join(componentsDirectory, "runtime"),
      nativeDirectory: join(componentsDirectory, "native"),
      releaseSource: {},
    };
  }
  const componentsDirectory = resolve(target.componentsDirectory);
  if (target.platform === "windows") {
    const identity = verifyWindowsComponents(componentsDirectory);
    return {
      runtimeDirectory: join(componentsDirectory, "runtime"),
      nativeDirectory: join(componentsDirectory, "native"),
      commandDirectory: join(componentsDirectory, "command"),
      releaseSource: { nodeArchive: identity.inputs.downloads["node.zip"].sha256 },
    };
  }
  const identity = verifyMacosComponents(componentsDirectory, target.architecture);
  return {
    runtimeDirectory: join(componentsDirectory, "runtime"),
    nativeDirectory: join(componentsDirectory, "native"),
    releaseSource: { nodeArchive: identity.inputs.downloads["node.tar.xz"].sha256 },
  };
}

function prepareCliRuntime(platform, architecture, scratch) {
  if (platform === "linux") {
    const recipe = JSON.parse(readFileSync(join(root, "release/node-static.json"), "utf8"));
    const input = staticNodeInput(release.node.version, recipe, architecture);
    const archive = join(releaseCache, "static-sources", input.sha256);
    fetchPinned(input, archive);
    run("tar", ["-xzf", archive, "-C", scratch]);
    return {
      runtimeDirectory: join(scratch, "runtime"),
      releaseSource: { nodeArchive: input.sha256 },
    };
  }
  const { download, archiveName, archiveRoot } = nodeInput(
    release.node,
    `${platform}-${architecture}`,
  );
  const archive = join(releaseCache, archiveName);
  fetchPinned(download, archive);
  const executable = platform === "windows" ? "node.exe" : "bin/node";
  run("bsdtar", [
    "-xf",
    archive,
    "-C",
    scratch,
    `${archiveRoot}/${executable}`,
    `${archiveRoot}/LICENSE`,
  ]);
  const runtimeDirectory = join(scratch, "runtime");
  mkdirSync(join(runtimeDirectory, "bin"), { recursive: true });
  cpSync(
    join(scratch, archiveRoot, executable),
    join(runtimeDirectory, "bin", platform === "windows" ? "node.exe" : "node"),
  );
  cpSync(join(scratch, archiveRoot, "LICENSE"), join(runtimeDirectory, "LICENSE"));
  return { runtimeDirectory, releaseSource: { nodeArchive: download.sha256 } };
}

function prepareServerRuntime(architecture, scratch) {
  const { download, archiveName, archiveRoot } = nodeInput(release.node, `linux-${architecture}`);
  const archive = join(releaseCache, archiveName);
  fetchPinned(download, archive);
  run("tar", ["-xJf", archive, "-C", scratch]);
  return {
    runtimeDirectory: join(scratch, archiveRoot),
    releaseSource: {
      nodeArchive: download.sha256,
      ubuntu: release.ubuntu,
      aptSources: digest(join(root, "release/ubuntu.sources")),
      caCertificates: release.caCertificates,
    },
  };
}

function readAgentArchives(agentTargets, sourceCommit) {
  const agents = [];
  for (const target of agentTargets) {
    const { name, archive: filename } = packageNames("agent", version, target);
    const archive = join(output, filename);
    const checksum = archive + ".sha256";
    if (!existsSync(archive) || !existsSync(checksum))
      throw new Error(`Build agent ${target} first`);
    if (readFileSync(checksum, "utf8") !== `${digest(archive)}  ${basename(archive)}\n`)
      throw new Error(`Agent archive checksum mismatch: ${target}`);
    const entries = capture("bsdtar", ["-tf", archive]).split("\n");
    if (entries.some((entry) => entry !== name && !entry.startsWith(name + "/")))
      throw new Error(`Unexpected agent archive roots: ${target}`);
    const manifest = JSON.parse(capture("bsdtar", ["-xOf", archive, name + "/release.json"]));
    if (!releaseMatches(manifest, expectedRelease(release, version, "agent", target, sourceCommit)))
      throw new Error(
        `Agent ${target} must match this source/version/platform/architecture; rebuild it`,
      );
    agents.push({ archive, checksum });
  }
  return agents;
}

function writeReleaseManifest(
  directory,
  kind,
  platform,
  architecture,
  sourceCommit,
  releaseSource,
) {
  writeFileSync(
    join(directory, "release.json"),
    JSON.stringify(
      {
        ...expectedRelease(release, version, kind, `${platform}-${architecture}`, sourceCommit),
        sourceDirty: false,
        lockfile: digest(join(root, "pnpm-lock.yaml")),
        ...releaseSource,
      },
      null,
      2,
    ) + "\n",
  );
}

function* readPackageEntries(directory) {
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    yield { file, stat };
    if (stat.isDirectory()) yield* readPackageEntries(file);
  }
}

function normalizePosixPermissions(directory, scratch) {
  chmodSync(directory, 0o755);
  for (const { file, stat } of readPackageEntries(directory)) {
    if (stat.isDirectory()) chmodSync(file, 0o755);
    else if (stat.isFile()) {
      const executable =
        !!(stat.mode & 0o111) || executablePathPattern.test(relative(directory, file));
      // pnpm can hard-link both store entries and local workspace dependencies.
      if (stat.nlink > 1) {
        const copy = join(scratch, "permission-file");
        cpSync(file, copy);
        renameSync(copy, file);
      }
      chmodSync(file, executable ? 0o755 : 0o644);
    }
  }
}

function verifyWindowsEntries(directory) {
  for (const { file, stat } of readPackageEntries(directory))
    if (!stat.isDirectory() && !stat.isFile())
      throw new Error(`Windows packages cannot contain links: ${file}`);
}

function verifyPortableSymlinks(directory) {
  for (const { file, stat } of readPackageEntries(directory)) {
    if (!stat.isSymbolicLink()) continue;
    const target = realpathSync(file);
    if (target !== directory && !target.startsWith(directory + "/"))
      throw new Error(`Portable symlink escapes package: ${file}`);
  }
}

function verifyStaticLinuxPackage(directory, expectedFiles) {
  const expectedELFs = new Set(expectedFiles);
  for (const { file, stat } of readPackageEntries(directory)) {
    if (!stat.isFile()) continue;
    const name = relative(directory, file);
    if (name.endsWith(".node")) throw new Error(`Dynamic Node addon is not supported: ${name}`);
    const bytes = readFileSync(file);
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    if (!expectedELFs.delete(name)) throw new Error(`Unexpected portable ELF: ${name}`);
    if (!(stat.mode & 0o111)) throw new Error(`Portable ELF is not executable: ${name}`);
    if (
      /INTERP/.test(capture("readelf", ["-l", file])) ||
      /NEEDED/.test(capture("readelf", ["-d", file]))
    )
      throw new Error(`Dynamic dependency in static portable package: ${name}`);
  }
  if (expectedELFs.size) throw new Error(`Missing portable ELF: ${[...expectedELFs].join(", ")}`);
}

function writePackageChecksums(directory, platform) {
  const entries = [];
  for (const { file, stat } of readPackageEntries(directory))
    if (stat.isFile()) entries.push(`${digest(file)}  ${relative(directory, file)}`);
  writeFileSync(join(directory, "SHA256SUMS"), entries.join("\n") + "\n");
  if (platform !== "windows") chmodSync(join(directory, "SHA256SUMS"), 0o644);
}

function archiveAndPublish(name, filename, platform, sourceCommit, scratch) {
  const staged = join(scratch, filename);
  if (platform === "windows") run("zip", ["-q", "-r", staged, name], { cwd: scratch });
  else run("tar", ["-czf", staged, "-C", scratch, name]);
  if (readSourceCommit(root) !== sourceCommit)
    throw new Error("Source changed during packaging; rerun the build");
  const archive = join(output, filename);
  const pending = `${archive}.${process.pid}.pending`;
  try {
    // Publish beside the destination so rename also works across cache filesystems.
    cpSync(staged, pending);
    writeFileSync(`${pending}.sha256`, `${digest(staged)}  ${filename}\n`);
    renameSync(pending, archive);
    renameSync(`${pending}.sha256`, `${archive}.sha256`);
  } finally {
    rmSync(pending, { force: true });
    rmSync(`${pending}.sha256`, { force: true });
  }
  console.log(`Release: ${archive}`);
}

function finishPortablePackage(kind, target, directory, sourceCommit, releaseSource, scratch) {
  const { platform, architecture } = target;
  writeReleaseManifest(directory, kind, platform, architecture, sourceCommit, releaseSource);
  if (platform === "windows") verifyWindowsEntries(directory);
  else {
    normalizePosixPermissions(directory, scratch);
    verifyPortableSymlinks(directory);
    if (platform === "linux") {
      const executables = ["runtime/bin/node"];
      if (kind === "agent")
        executables.push(
          "dist/native/bin/tmux",
          "dist/native/bin/rename-noreplace",
          "dist/native/bin/rg",
          "dist/native/bin/pty-bridge",
        );
      verifyStaticLinuxPackage(directory, executables);
    }
  }
  writePackageChecksums(directory, platform);
  const { name, archive } = packageNames(kind, version, `${platform}-${architecture}`);
  archiveAndPublish(name, archive, platform, sourceCommit, scratch);
}

async function packageAgent(target, sourceCommit, scratch) {
  const { platform, architecture } = target;
  compileProjects(["shared", "agent", "cli", "terminal-recorder"]);
  const prepared = prepareAgentComponents(target, scratch);
  const { name } = packageNames("agent", version, `${platform}-${architecture}`);
  const directory = createPackageDirectory(name, scratch);
  deployProductionPackage("shared", join(directory, "shared"), platform);
  setSharedResourceRoot(join(directory, "shared"));
  deployProductionPackage("agent", join(directory, "agent"), platform);
  connectSharedPackage(join(directory, "agent"), platform, { deployed: true });
  cpSync(join(root, "packages/cli/dist"), join(directory, "cli/dist"), { recursive: true });
  cpSync(join(root, "packages/cli/package.json"), join(directory, "cli/package.json"));
  connectSharedPackage(join(directory, "cli"), platform, { deployed: false });
  deployProductionPackage("terminal-recorder", join(directory, "terminal-recorder"), platform);
  connectSharedPackage(join(directory, "terminal-recorder"), platform, { deployed: true });
  if (platform === "linux")
    run("cp", ["-a", prepared.runtimeDirectory, join(directory, "runtime")]);
  else cpSync(prepared.runtimeDirectory, join(directory, "runtime"), { recursive: true });
  cpSync(prepared.nativeDirectory, join(directory, "dist/native"), { recursive: true });

  mkdirSync(join(directory, "deploy"));
  mkdirSync(join(directory, "bin"));
  const { unixInstallationLayout, windowsInstallationLayout } = await import(
    "../packages/agent/dist/install/layout.js"
  );
  if (platform === "windows") {
    cpSync(
      join(root, "deploy/winsw/kiteline-agent.xml"),
      join(directory, "deploy/kiteline-agent.xml"),
    );
    const { nodeEnvironmentKeys } = await import("../packages/shared/dist/terminal/node.js");
    cpSync(prepared.commandDirectory, join(directory, "command"), { recursive: true });
    const launchers = windowsAgentLaunchers({
      runtimeFiles: windowsRuntimeFiles.map(componentPackagePath),
      nodeEnvironmentKeys,
      layout: windowsInstallationLayout,
    });
    writeFileSync(join(directory, "bin/kiteline-agent.ps1"), launchers.portable);
    writeFileSync(join(directory, "bin/kiteline-agent-installed.ps1"), launchers.installed);
    chmodSync(join(directory, "bin/kiteline-agent.ps1"), 0o755);
    writeFileSync(join(directory, "bin/kiteline.ps1"), windowsCliLauncher(terminalReset));
    chmodSync(join(directory, "bin/kiteline.ps1"), 0o755);
  } else {
    if (platform === "macos")
      cpSync(
        join(root, "deploy/launchd/kiteline-agent.plist"),
        join(directory, "deploy/kiteline-agent.plist"),
      );
    else
      cpSync(
        join(root, "deploy/systemd/kiteline-agent.service"),
        join(directory, "deploy/kiteline-agent.service"),
      );
    const paths = {
      directory: unixInstallationLayout.directory,
      management: unixInstallationLayout.managementFile,
      managementFd: unixInstallationLayout.managementLockFd,
      use: unixInstallationLayout.useFile,
    };
    const launcherPlatform = platform === "macos" ? "darwin" : "linux";
    writeFileSync(
      join(directory, "bin/kiteline-agent"),
      agentLauncher(undefined, paths, launcherPlatform),
    );
    writeFileSync(
      join(directory, "bin/kiteline-agent-installed"),
      agentLauncher(unixInstallationLayout.directory, paths, launcherPlatform),
    );
    cpSync(join(root, "installer/kiteline"), join(directory, "bin/kiteline"));
  }
  finishPortablePackage("agent", target, directory, sourceCommit, prepared.releaseSource, scratch);
}

function packageCli(target, sourceCommit, scratch) {
  const { platform, architecture } = target;
  compileProjects(["shared", "cli"]);
  const prepared = prepareCliRuntime(platform, architecture, scratch);
  const { name } = packageNames("cli", version, `${platform}-${architecture}`);
  const directory = createPackageDirectory(name, scratch);
  deployProductionPackage("shared", join(directory, "shared"), platform);
  setSharedResourceRoot(join(directory, "shared"));
  cpSync(join(root, "packages/cli/dist"), join(directory, "cli/dist"), { recursive: true });
  cpSync(join(root, "packages/cli/package.json"), join(directory, "cli/package.json"));
  connectSharedPackage(join(directory, "cli"), platform, { deployed: false });
  if (platform === "linux")
    run("cp", ["-a", prepared.runtimeDirectory, join(directory, "runtime")]);
  else cpSync(prepared.runtimeDirectory, join(directory, "runtime"), { recursive: true });
  mkdirSync(join(directory, "bin"));
  if (platform === "windows") {
    writeFileSync(join(directory, "bin/kiteline.ps1"), windowsCliLauncher(terminalReset));
    chmodSync(join(directory, "bin/kiteline.ps1"), 0o755);
  } else cpSync(join(root, "installer/kiteline"), join(directory, "bin/kiteline"));
  finishPortablePackage("cli", target, directory, sourceCommit, prepared.releaseSource, scratch);
}

function packageServer(architecture, agentTargets, sourceCommit, scratch) {
  compileProjects(["shared", "server"]);
  run("pnpm", ["--filter", "@kiteline/web", "build"]);
  const agents = readAgentArchives(agentTargets, sourceCommit);
  const prepared = prepareServerRuntime(architecture, scratch);
  const { name, archive: filename } = packageNames("server", version, `linux-${architecture}`);
  const directory = createPackageDirectory(name, scratch);
  deployProductionPackage("shared", join(directory, "shared"), "linux");
  setSharedResourceRoot(join(directory, "shared"));
  deployProductionPackage("server", join(directory, "server"), "linux");
  connectSharedPackage(join(directory, "server"), "linux", { deployed: true });
  cpSync(join(root, "packages/web/dist"), join(directory, "web/dist"), { recursive: true });
  mkdirSync(join(directory, "installer"));
  for (const name of ["connect.in.sh", "upgrade.in.sh", "windows-entry.in.ps1"])
    cpSync(join(root, "installer", name), join(directory, "installer", name));
  const downloads = join(directory, "downloads");
  mkdirSync(downloads);
  for (const { archive, checksum } of agents)
    for (const file of [archive, checksum]) cpSync(file, join(downloads, basename(file)));
  cpSync(join(root, "installer/install.sh"), join(downloads, "install.sh"));
  cpSync(join(root, "installer/install.ps1"), join(downloads, "install.ps1"));
  mkdirSync(join(directory, "runtime/bin"), { recursive: true });
  cpSync(join(prepared.runtimeDirectory, "bin/node"), join(directory, "runtime/bin/node"));
  cpSync(join(prepared.runtimeDirectory, "LICENSE"), join(directory, "runtime/LICENSE"));
  mkdirSync(join(directory, "bin"));
  cpSync(join(root, "installer/kiteline-server"), join(directory, "bin/kiteline-server"));
  writeReleaseManifest(
    directory,
    "server",
    "linux",
    architecture,
    sourceCommit,
    prepared.releaseSource,
  );
  normalizePosixPermissions(directory, scratch);
  writePackageChecksums(directory, "linux");
  archiveAndPublish(name, filename, "linux", sourceCommit, scratch);
}

function readPackageRequest() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "agent-target": { type: "string" },
      "windows-components": { type: "string" },
      "macos-components": { type: "string" },
    },
  });
  const usage =
    "Usage: pnpm package server amd64|arm64 [--agent-target=linux-amd64,linux-arm64,windows-amd64,macos-amd64,macos-arm64] | agent linux-amd64|linux-arm64 | agent windows-amd64 --windows-components=PATH | agent macos-amd64|macos-arm64 --macos-components=PATH | cli linux-amd64|linux-arm64|windows-amd64|macos-amd64|macos-arm64";
  if (positionals.length !== 2) throw new Error(usage);
  const [kind, target] = positionals;
  const windowsComponents = values["windows-components"];
  const macosComponents = values["macos-components"];

  if (kind === "server") {
    const agentTargets = values["agent-target"]?.split(",") ?? allAgentTargets;
    if (
      !serverArchitectures.includes(target) ||
      windowsComponents !== undefined ||
      macosComponents !== undefined ||
      agentTargets.some((target) => !allAgentTargets.includes(target)) ||
      new Set(agentTargets).size !== agentTargets.length
    )
      throw new Error(usage);
    return { kind, architecture: target, agentTargets };
  }

  if (kind === "cli") {
    if (!allAgentTargets.includes(target) || Object.keys(values).length) throw new Error(usage);
    const [platform, architecture] = target.split("-");
    return { kind, target: { platform, architecture } };
  }

  if (kind === "agent") {
    if (!allAgentTargets.includes(target) || values["agent-target"] !== undefined)
      throw new Error(usage);
    const [platform, architecture] = target.split("-");
    if (platform === "linux") {
      if (windowsComponents !== undefined || macosComponents !== undefined) throw new Error(usage);
      return { kind, target: { platform, architecture } };
    }
    if (platform === "windows") {
      if (!windowsComponents || macosComponents !== undefined) throw new Error(usage);
      return { kind, target: { platform, architecture, componentsDirectory: windowsComponents } };
    }
    if (!macosComponents || windowsComponents !== undefined) throw new Error(usage);
    return { kind, target: { platform, architecture, componentsDirectory: macosComponents } };
  }

  throw new Error(usage);
}

const request = readPackageRequest();
const scratch = realpathSync(mkdtempSync("/var/tmp/kiteline-package-"));
try {
  const sourceCommit = readSourceCommit(root);
  mkdirSync(releaseCache, { recursive: true });
  mkdirSync(output, { recursive: true });
  if (request.kind === "agent") await packageAgent(request.target, sourceCommit, scratch);
  else if (request.kind === "cli") packageCli(request.target, sourceCommit, scratch);
  else packageServer(request.architecture, request.agentTargets, sourceCommit, scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
