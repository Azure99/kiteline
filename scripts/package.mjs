import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  staticNodeInput,
} from "./release-artifacts.mjs";
import { digest, fetchPinned, run as execute } from "./release-inputs.mjs";
import { windowsRuntimeFiles, windowsComponentPath } from "./windows-components.ts";
import { agentLauncher, windowsAgentLaunchers, windowsCliLauncher } from "./agent-launcher.ts";
import { terminalReset } from "../packages/cli/src/terminal-reset.ts";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(join(root, "release/inputs.json"), "utf8"));
assert.equal(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node,
  release.node,
  "package.json engines.node and release/inputs.json node must pin the same version",
);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "agent-target": { type: "string" },
    "windows-components": { type: "string" },
    "macos-components": { type: "string" },
  },
});
const [kind, target] = positionals;
const [platform, arch] = kind === "server" ? ["linux", target] : (target ?? "").split("-");
const portable = kind === "agent" || kind === "cli";
const windows = platform === "windows";
const linuxPortable = portable && platform === "linux";
const windowsAgent = kind === "agent" && platform === "windows";
const macosAgent = kind === "agent" && platform === "macos";
const linuxAgent = kind === "agent" && platform === "linux";
const windowsComponents = values["windows-components"];
const macosComponents = values["macos-components"];
const agentTargets = values["agent-target"]?.split(",") ?? allAgentTargets;
if (
  positionals.length !== 2 ||
  !["server", "agent", "cli"].includes(kind) ||
  (portable && !allAgentTargets.includes(target)) ||
  (kind === "server" && !serverArchitectures.includes(arch)) ||
  (values["agent-target"] !== undefined && kind !== "server") ||
  agentTargets.some((target) => !allAgentTargets.includes(target)) ||
  new Set(agentTargets).size !== agentTargets.length ||
  (windowsAgent ? !windowsComponents : windowsComponents !== undefined) ||
  (macosAgent ? !macosComponents : macosComponents !== undefined)
)
  throw new Error(
    "Usage: pnpm package server amd64|arm64 [--agent-target=linux-amd64,linux-arm64,windows-amd64,macos-amd64,macos-arm64] | agent linux-amd64|linux-arm64 | agent windows-amd64 --windows-components=PATH | agent macos-amd64|macos-arm64 --macos-components=PATH | cli linux-amd64|linux-arm64|windows-amd64|macos-amd64|macos-arm64",
  );
const node = release.nodeArchives[arch];
const projects = ["shared", kind, ...(kind === "agent" ? ["cli", "terminal-recorder"] : [])];
const { version } = JSON.parse(
  readFileSync(join(root, "packages/shared/src/version.json"), "utf8"),
);
const output = join(root, "dist/releases");
const cache = "/var/tmp/kiteline-release-cache";
const temporary = realpathSync(mkdtempSync("/var/tmp/kiteline-package-"));
function run(command, args, options = {}) {
  return execute(command, args, { cwd: root, ...options });
}
function text(command, args) {
  return run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
async function agentArchives(sourceCommit) {
  const agents = [];
  for (const target of agentTargets) {
    const { name, archive: filename } = packageNames("agent", version, target);
    const archive = join(output, filename);
    const checksum = archive + ".sha256";
    if (!existsSync(archive) || !existsSync(checksum))
      throw new Error(`Build agent ${target} first`);
    if (readFileSync(checksum, "utf8") !== `${digest(archive)}  ${basename(archive)}\n`)
      throw new Error(`Agent archive checksum mismatch: ${target}`);
    const entries = text("bsdtar", ["-tf", archive]).split("\n");
    if (entries.some((entry) => entry !== name && !entry.startsWith(name + "/")))
      throw new Error(`Unexpected agent archive roots: ${target}`);
    const manifest = JSON.parse(text("bsdtar", ["-xOf", archive, name + "/release.json"]));
    if (!releaseMatches(manifest, expectedRelease(release, version, "agent", target, sourceCommit)))
      throw new Error(
        `Agent ${target} must match this source/version/platform/architecture; rebuild it`,
      );
    agents.push({ archive, checksum });
  }
  return agents;
}
function deploy(name, target) {
  if (name === "cli") {
    // CLI only depends on the shared package deployed beside it.
    cpSync(join(root, "packages/cli/dist"), join(target, "dist"), { recursive: true });
    cpSync(join(root, "packages/cli/package.json"), join(target, "package.json"));
  } else {
    run("pnpm", [
      "--filter",
      `@kiteline/${name}`,
      "deploy",
      "--prod",
      "--config.inject-workspace-packages=true",
      `--config.node-linker=${windows ? "hoisted" : "isolated"}`,
      target,
    ]);
  }
  if (name === "shared") {
    const manifest = join(target, "package.json");
    const metadata = JSON.parse(readFileSync(manifest, "utf8"));
    // Source resources sit above packages; release resources share the component parent.
    metadata.kitelineResourceRoot = "..";
    writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n");
  } else {
    const link = join(target, "node_modules/@kiteline/shared");
    const injected =
      windows || name === "cli" ? undefined : resolve(realpathSync(link), "../../..");
    rmSync(link, { recursive: true, force: true });
    if (windows) {
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
      mkdirSync(join(target, "node_modules/@kiteline"), { recursive: true });
      symlinkSync("../../../shared", link);
      if (injected) rmSync(injected, { recursive: true, force: true });
    }
    const manifest = join(target, "package.json");
    const metadata = JSON.parse(readFileSync(manifest, "utf8"));
    metadata.dependencies["@kiteline/shared"] = "file:../shared";
    writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n");
  }
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "node_modules/.pnpm/lock.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.package-map.json",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
  ])
    rmSync(join(target, path), { recursive: true, force: true });
}
function checksums(directory) {
  const entries = [];
  const expectedELFs = new Set(
    linuxPortable
      ? [
          "runtime/bin/node",
          ...(kind === "agent"
            ? [
                "dist/native/bin/tmux",
                "dist/native/bin/rename-noreplace",
                "dist/native/bin/rg",
                "dist/native/bin/pty-bridge",
              ]
            : []),
        ]
      : [],
  );
  function walk(path) {
    if (!windows) chmodSync(path, 0o755);
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        const name = relative(directory, file);
        const executable = !!(stat.mode & 0o111) || executablePathPattern.test(name);
        if (!windows) {
          // pnpm can hard-link both store entries and local workspace dependencies.
          if (stat.nlink > 1) {
            const copy = join(temporary, "permission-file");
            cpSync(file, copy);
            renameSync(copy, file);
          }
          chmodSync(file, executable ? 0o755 : 0o644);
        }
        const bytes = readFileSync(file);
        if (linuxPortable) {
          if (name.endsWith(".node"))
            throw new Error(`Dynamic Node addon is not supported: ${name}`);
          if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
            if (!expectedELFs.delete(name)) throw new Error(`Unexpected portable ELF: ${name}`);
            if (!executable) throw new Error(`Portable ELF is not executable: ${name}`);
            if (
              /INTERP/.test(text("readelf", ["-l", file])) ||
              /NEEDED/.test(text("readelf", ["-d", file]))
            )
              throw new Error(`Dynamic dependency in static portable package: ${name}`);
          }
        }
        entries.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
      } else if (windows) throw new Error(`Windows packages cannot contain links: ${file}`);
      else if (portable && stat.isSymbolicLink()) {
        const target = realpathSync(file);
        if (target !== directory && !target.startsWith(directory + "/"))
          throw new Error(`Portable symlink escapes package: ${file}`);
      }
    }
  }
  walk(directory);
  if (expectedELFs.size) throw new Error(`Missing portable ELF: ${[...expectedELFs].join(", ")}`);
  writeFileSync(join(directory, "SHA256SUMS"), entries.join("\n") + "\n");
  if (!windows) chmodSync(join(directory, "SHA256SUMS"), 0o644);
}

function cliRuntime() {
  if (platform === "linux") {
    const recipe = JSON.parse(readFileSync(join(root, "release/node-static.json"), "utf8"));
    const input = staticNodeInput(release.node, recipe, arch);
    const archive = join(cache, "static-sources", input.sha256);
    fetchPinned(input, archive);
    run("tar", ["-xzf", archive, "-C", temporary]);
    return { path: join(temporary, "runtime"), sha256: input.sha256 };
  }
  const recipe = JSON.parse(readFileSync(join(root, `release/agent-${platform}.json`), "utf8"));
  const prefix = `node-v${release.node}-${windows ? "win" : "darwin"}-${node.architecture}`;
  const filename = `${prefix}.${windows ? "zip" : "tar.xz"}`;
  const input = {
    url: `https://nodejs.org/dist/v${release.node}/${filename}`,
    sha256: windows ? recipe.nodeArchiveSha256 : recipe.architectures[arch].nodeArchiveSha256,
  };
  const archive = join(cache, filename);
  fetchPinned(input, archive);
  run("bsdtar", [
    "-xf",
    archive,
    "-C",
    temporary,
    `${prefix}/${windows ? "node.exe" : "bin/node"}`,
    `${prefix}/LICENSE`,
  ]);
  const path = join(temporary, "runtime");
  mkdirSync(join(path, "bin"), { recursive: true });
  cpSync(
    join(temporary, prefix, windows ? "node.exe" : "bin/node"),
    join(path, "bin", windows ? "node.exe" : "node"),
  );
  cpSync(join(temporary, prefix, "LICENSE"), join(path, "LICENSE"));
  return { path, sha256: input.sha256 };
}
try {
  const sourceCommit = readSourceCommit(root);
  for (const name of projects)
    rmSync(join(root, "packages", name, "dist"), { recursive: true, force: true });
  run("pnpm", ["exec", "tsc", "-b", ...projects.map((name) => `packages/${name}`)]);
  if (kind === "server") run("pnpm", ["--filter", "@kiteline/web", "build"]);
  const agents = kind === "server" ? await agentArchives(sourceCommit) : [];
  mkdirSync(cache, { recursive: true });
  mkdirSync(output, { recursive: true });
  let runtime;
  let staticBuild;
  let windowsBuild;
  let macosBuild;
  let cliNodeArchive;
  const native = join(temporary, "native");
  if (kind === "cli") {
    const prepared = cliRuntime();
    runtime = prepared.path;
    cliNodeArchive = prepared.sha256;
  } else if (windowsAgent) {
    const components = resolve(windowsComponents);
    windowsBuild = verifyWindowsComponents(components);
    runtime = join(components, "runtime");
    cpSync(join(components, "native"), native, { recursive: true });
  } else if (macosAgent) {
    const components = resolve(macosComponents);
    macosBuild = verifyMacosComponents(components, arch);
    runtime = join(components, "runtime");
    cpSync(join(components, "native"), native, { recursive: true });
  } else if (linuxAgent) {
    const components = join(temporary, "linux");
    buildLinuxComponents(components, arch);
    runtime = join(components, "runtime");
    run("cp", ["-a", join(components, "native"), native]);
    staticBuild = JSON.parse(readFileSync(join(components, "build.json"), "utf8"));
  } else {
    const filename = `node-v${release.node}-linux-${node.architecture}.tar.xz`;
    const archive = join(cache, filename);
    fetchPinned(
      { url: `https://nodejs.org/dist/v${release.node}/${filename}`, sha256: node.sha256 },
      archive,
    );
    run("tar", ["-xJf", archive, "-C", temporary]);
    runtime = join(temporary, filename.slice(0, -7));
  }
  if (kind === "agent") {
    const recorder = JSON.parse(
      readFileSync(join(root, "packages/terminal-recorder/package.json"), "utf8"),
    ).dependencies;
    const web = JSON.parse(
      readFileSync(join(root, "packages/web/package.json"), "utf8"),
    ).dependencies;
    const shared = JSON.parse(
      readFileSync(join(root, "packages/shared/package.json"), "utf8"),
    ).dependencies;
    const { terminalProfile } = await import("../packages/shared/dist/protocol/index.js");
    const identityPath = join(native, "identity.json");
    writeFileSync(
      identityPath,
      JSON.stringify(
        {
          ...JSON.parse(readFileSync(identityPath, "utf8")),
          headless: recorder["@xterm/headless"],
          xterm: web["@xterm/xterm"],
          serialize: recorder["@xterm/addon-serialize"],
          unicode11: shared["@xterm/addon-unicode11"],
          profile: terminalProfile,
        },
        null,
        2,
      ) + "\n",
    );
  }
  const { name, archive: filename } = packageNames(kind, version, `${platform}-${arch}`);
  const destination = join(temporary, name);
  mkdirSync(destination);
  cpSync(join(root, "LICENSE"), join(destination, "LICENSE"));
  for (const name of projects) deploy(name, join(destination, name));
  if (kind === "agent") {
    cpSync(native, join(destination, "dist/native"), { recursive: true });
    mkdirSync(join(destination, "deploy"));
    const manager = windowsAgent ? "xml" : macosAgent ? "plist" : "service";
    const examples = windowsAgent ? "winsw" : macosAgent ? "launchd" : "systemd";
    cpSync(
      join(root, `deploy/${examples}/kiteline-agent.${manager}`),
      join(destination, `deploy/kiteline-agent.${manager}`),
    );
  } else if (kind === "server") {
    cpSync(join(root, "packages/web/dist"), join(destination, "web/dist"), { recursive: true });
    mkdirSync(join(destination, "installer"));
    for (const name of ["connect.in.sh", "upgrade.in.sh", "windows-entry.in.ps1"])
      cpSync(join(root, "installer", name), join(destination, "installer", name));
    const downloads = join(destination, "downloads");
    mkdirSync(downloads);
    for (const { archive, checksum } of agents)
      for (const file of [archive, checksum]) cpSync(file, join(downloads, basename(file)));
    cpSync(join(root, "installer/install.sh"), join(downloads, "install.sh"));
    cpSync(join(root, "installer/install.ps1"), join(downloads, "install.ps1"));
  }
  if (windows || platform === "macos")
    cpSync(runtime, join(destination, "runtime"), { recursive: true });
  else if (linuxPortable) run("cp", ["-a", runtime, join(destination, "runtime")]);
  else {
    mkdirSync(join(destination, "runtime/bin"), { recursive: true });
    cpSync(join(runtime, "bin/node"), join(destination, "runtime/bin/node"));
    cpSync(join(runtime, "LICENSE"), join(destination, "runtime/LICENSE"));
  }
  mkdirSync(join(destination, "bin"));
  const launcher = join(destination, "bin", `kiteline-${kind}${windows ? ".ps1" : ""}`);
  if (windowsAgent) {
    const { windowsInstallationLayout } = await import("../packages/agent/dist/install/layout.js");
    const { nodeEnvironmentKeys } = await import("../packages/shared/dist/terminal/node.js");
    cpSync(join(resolve(windowsComponents), "command"), join(destination, "command"), {
      recursive: true,
    });
    const launchers = windowsAgentLaunchers({
      runtimeFiles: windowsRuntimeFiles.map(windowsComponentPath),
      nodeEnvironmentKeys,
      layout: windowsInstallationLayout,
    });
    writeFileSync(launcher, launchers.portable);
    writeFileSync(join(destination, "bin/kiteline-agent-installed.ps1"), launchers.installed);
  } else if (kind === "agent") {
    const { unixInstallationLayout } = await import("../packages/agent/dist/install/layout.js");
    const paths = {
      directory: unixInstallationLayout.directory,
      management: unixInstallationLayout.managementFile,
      managementFd: unixInstallationLayout.managementLockFd,
      use: unixInstallationLayout.useFile,
    };
    const platform = macosAgent ? "darwin" : "linux";
    writeFileSync(launcher, agentLauncher(undefined, paths, platform));
    writeFileSync(
      join(destination, "bin/kiteline-agent-installed"),
      agentLauncher(unixInstallationLayout.directory, paths, platform),
    );
    chmodSync(join(destination, "bin/kiteline-agent-installed"), 0o755);
  } else if (kind === "server") cpSync(join(root, "installer/kiteline-server"), launcher);
  if (kind !== "cli") chmodSync(launcher, 0o755);
  if (portable) {
    const name = `kiteline${windows ? ".ps1" : ""}`;
    if (windows) {
      writeFileSync(join(destination, "bin", name), windowsCliLauncher(terminalReset));
    } else cpSync(join(root, "installer", name), join(destination, "bin", name));
    chmodSync(join(destination, "bin", name), 0o755);
  }
  writeFileSync(
    join(destination, "release.json"),
    JSON.stringify(
      {
        ...expectedRelease(release, version, kind, `${platform}-${arch}`, sourceCommit),
        sourceDirty: false,
        lockfile: digest(join(root, "pnpm-lock.yaml")),
        ...(cliNodeArchive
          ? { nodeArchive: cliNodeArchive }
          : windowsBuild
            ? { nodeArchive: windowsBuild.inputs.downloads["node.zip"].sha256 }
            : macosBuild
              ? { nodeArchive: macosBuild.inputs.downloads["node.tar.xz"].sha256 }
              : staticBuild
                ? { staticBuild }
                : {
                    nodeArchive: node.sha256,
                    ubuntu: release.ubuntu,
                    aptSources: digest(join(root, "release/ubuntu.sources")),
                    caCertificates: release.caCertificates,
                  }),
      },
      null,
      2,
    ) + "\n",
  );
  checksums(destination);
  const tarball = join(output, filename);
  const staged = join(temporary, filename);
  if (windows) run("zip", ["-q", "-r", staged, name], { cwd: temporary });
  else run("tar", ["-czf", staged, "-C", temporary, name]);
  if (readSourceCommit(root) !== sourceCommit)
    throw new Error("Source changed during packaging; rerun the build");
  const pending = `${tarball}.${process.pid}.pending`;
  try {
    // Publish beside the destination so rename also works across cache filesystems.
    cpSync(staged, pending);
    writeFileSync(`${pending}.sha256`, `${digest(staged)}  ${filename}\n`);
    renameSync(pending, tarball);
    renameSync(`${pending}.sha256`, `${tarball}.sha256`);
  } finally {
    rmSync(pending, { force: true });
    rmSync(`${pending}.sha256`, { force: true });
  }
  console.log(`Release: ${tarball}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
