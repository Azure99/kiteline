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
import { spawnSync } from "node:child_process";
import { basename, resolve, join, relative } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildStaticAgent } from "./build-agent-static.mjs";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";
import { verifyWindowsComponents } from "./build-windows-components.mjs";
import { verifyMacosComponents } from "./build-macos-components.mjs";
import {
  requiredWindowsComponents,
  windowsComponentFiles,
  windowsComponentPath,
} from "../shared/src/windows/components.ts";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(join(root, "deploy/release.json"), "utf8"));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "agent-target": { type: "string" },
    "windows-components": { type: "string" },
    "macos-components": { type: "string" },
  },
});
const [kind, target] = positionals;
const windowsAgent = kind === "agent" && target === "windows-amd64";
const macosAgent = kind === "agent" && target === "macos-amd64";
const arch = windowsAgent || macosAgent ? "amd64" : target;
const windowsComponents = values["windows-components"];
const macosComponents = values["macos-components"];
const allAgentTargets = ["linux-amd64", "linux-arm64", "windows-amd64", "macos-amd64"];
const agentTargets = values["agent-target"]?.split(",") ?? allAgentTargets;
if (
  positionals.length !== 2 ||
  !["server", "agent"].includes(kind) ||
  !Object.hasOwn(release.nodeArchives, arch ?? "") ||
  (values["agent-target"] !== undefined && kind !== "server") ||
  agentTargets.some((target) => !allAgentTargets.includes(target)) ||
  new Set(agentTargets).size !== agentTargets.length ||
  (windowsAgent ? !windowsComponents : windowsComponents !== undefined) ||
  (macosAgent ? !macosComponents : macosComponents !== undefined)
)
  throw new Error(
    "Usage: pnpm package agent|server amd64|arm64 [--agent-target=linux-amd64,linux-arm64,windows-amd64,macos-amd64 (server only)] | agent windows-amd64 --windows-components=PATH | agent macos-amd64 --macos-components=PATH",
  );
const node = release.nodeArchives[arch];
const staticAgent = kind === "agent" && arch === "amd64" && !windowsAgent && !macosAgent;
const { version } = JSON.parse(readFileSync(join(root, "shared/src/version.json"), "utf8"));
const output = join(root, "dist/releases");
const cache = "/var/tmp/kiteline-release-cache";
const temporary = realpathSync(mkdtempSync("/var/tmp/kiteline-package-"));
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}
function text(command, args) {
  return run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
function sourceDigest() {
  const files = text("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "agent",
    "server",
    "web",
    "shared",
    "terminal-recorder",
    "native",
    "scripts",
    "deploy",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig*.json",
  ])
    .split("\0")
    .filter((file) => file && existsSync(join(root, file)));
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort())
    hash
      .update(file)
      .update("\0")
      .update(digest(join(root, file)))
      .update("\0");
  return hash.digest("hex");
}
async function agentArchives(sourceHash) {
  const agents = [];
  for (const target of agentTargets) {
    const [platform, architecture] = target.split("-");
    const windows = platform === "windows";
    const macos = platform === "macos";
    const name = `kiteline-agent-${version}-${target}`;
    const archive = join(output, `${name}.${windows ? "zip" : "tar.gz"}`);
    const checksum = archive + ".sha256";
    if (!existsSync(archive) || !existsSync(checksum))
      throw new Error(`Build agent ${target} first`);
    if (readFileSync(checksum, "utf8") !== `${digest(archive)}  ${basename(archive)}\n`)
      throw new Error(`Agent archive checksum mismatch: ${target}`);
    const extracted = join(temporary, target);
    mkdirSync(extracted);
    run("bsdtar", ["-xf", archive, "-C", extracted, "--no-same-owner"]);
    if (!isDeepStrictEqual(readdirSync(extracted), [name]))
      throw new Error(`Unexpected agent archive roots: ${target}`);
    const directory = join(extracted, name);
    const manifest = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
    if (
      manifest.kind !== "agent" ||
      manifest.platform !== platform ||
      manifest.version !== version ||
      manifest.architecture !== release.nodeArchives[architecture].architecture ||
      manifest.node !== release.node ||
      manifest.sourceDigest !== sourceHash
    )
      throw new Error(
        `Agent ${target} must match this source/version/platform/architecture; rebuild it`,
      );
    const expected = new Map();
    for (const line of readFileSync(join(directory, "SHA256SUMS"), "utf8").trimEnd().split("\n")) {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      if (!match || expected.has(match[2]))
        throw new Error(`Invalid agent checksum record: ${target}`);
      expected.set(match[2], match[1]);
    }
    const actual = new Map();
    function walk(path) {
      for (const name of readdirSync(path)) {
        const file = join(path, name);
        const key = relative(directory, file);
        const stat = lstatSync(file);
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) {
          if (key === "SHA256SUMS") continue;
          const hash = digest(file);
          if (expected.get(key) !== hash)
            throw new Error(`Agent file checksum mismatch: ${target}/${key}`);
          actual.set(key, hash);
        } else if (
          !windows &&
          stat.isSymbolicLink() &&
          realpathSync(file).startsWith(directory + "/")
        )
          continue;
        else throw new Error(`Unsupported agent file: ${target}/${key}`);
      }
    }
    walk(directory);
    if (expected.size !== actual.size) throw new Error(`Agent file set mismatch: ${target}`);
    const required = [
      "release.json",
      "agent/dist/main.js",
      "agent/package.json",
      "shared/package.json",
      "shared/dist/version.json",
      "terminal-recorder/dist/main.js",
      "terminal-recorder/package.json",
      "dist/native/identity.json",
      "runtime/LICENSE",
      `runtime/bin/node${windows ? ".exe" : ""}`,
      `bin/kiteline-agent${windows ? ".ps1" : ""}`,
      `bin/kiteline-agent-installed${windows ? ".ps1" : ""}`,
    ];
    if (!windows)
      required.push(
        "dist/native/bin/tmux",
        "dist/native/bin/rename-noreplace",
        `dist/native/share/terminfo/${macos ? "74" : "t"}/tmux-256color`,
      );
    if (target === "linux-amd64")
      required.push("dist/native/bin/rg", "dist/native/share/terminfo-legacy/t/tmux-256color");
    if (macos)
      required.push("dist/native/bin/rg", "dist/native/bin/flock", "dist/native/bin/entry-name");
    for (const file of required)
      if (!actual.has(file)) throw new Error(`Missing required agent file: ${target}/${file}`);
    const identity = JSON.parse(readFileSync(join(directory, "dist/native/identity.json"), "utf8"));
    if (windows) {
      if (
        identity.linkage !== "windows-msys" ||
        identity.architecture !== manifest.architecture ||
        identity.node !== `v${release.node}`
      )
        throw new Error(`Agent native platform identity mismatch: ${target}`);
      const components = Object.fromEntries(
        [...actual].flatMap(([file, hash]) =>
          file === "dist/native/identity.json"
            ? []
            : file.startsWith("dist/native/")
              ? [[file.slice(5), hash]]
              : file.startsWith("runtime/")
                ? [[file, hash]]
                : [],
        ),
      );
      for (const file of requiredWindowsComponents(identity.inputs.downloads))
        if (!components[file]) throw new Error(`Missing required Windows component: ${file}`);
      if (!isDeepStrictEqual(components, identity.files))
        throw new Error("Windows component files do not match their identity");
      const recipe = JSON.parse(
        readFileSync(
          join(directory, "dist/native/sources/recipe/deploy/agent-windows.json"),
          "utf8",
        ),
      );
      const sources = Object.fromEntries(
        Object.entries(recipe.sources).map(([name, value]) => ["sources/" + name, value]),
      );
      const catalog = Object.fromEntries(
        Object.entries(identity.inputs.downloads).filter(([name]) => name.startsWith("sources/")),
      );
      if (!isDeepStrictEqual(sources, catalog))
        throw new Error("Windows corresponding source catalog does not match its build recipe");
      for (const [name, source] of Object.entries(sources))
        if (components["native/" + name] !== source.sha256)
          throw new Error(`Windows corresponding source checksum mismatch: ${name}`);
    } else if (macos) {
      if (
        identity.linkage !== "macos-system" ||
        identity.architecture !== manifest.architecture ||
        identity.node !== `v${release.node}`
      )
        throw new Error(`Agent native platform identity mismatch: ${target}`);
      verifyMacosComponents(directory, true);
    } else {
      if (
        identity.architecture !== manifest.architecture ||
        identity.node !== `v${release.node}` ||
        identity.linkage !== (architecture === "amd64" ? "static-musl" : "dynamic")
      )
        throw new Error(`Agent native platform identity mismatch: ${target}`);
      const components = {
        "bin/tmux": identity.tmuxBinary,
        "bin/rename-noreplace": identity.helperBinary,
        ...(architecture === "amd64"
          ? {
              "bin/rg": identity.ripgrep?.binarySha256,
              "share/terminfo/t/tmux-256color": identity.terminfoResources?.modern,
              "share/terminfo-legacy/t/tmux-256color": identity.terminfoResources?.legacy,
            }
          : Object.fromEntries(
              Object.entries(identity.libraries).map(([name, hash]) => [`lib/${name}`, hash]),
            )),
      };
      for (const [file, hash] of Object.entries(components))
        if (!actual.has(`dist/native/${file}`) || actual.get(`dist/native/${file}`) !== hash)
          throw new Error(`Agent native component mismatch: ${target}/${file}`);
    }
    agents.push({ archive, checksum });
  }
  return agents;
}
function deploy(name, target) {
  run("pnpm", [
    "--filter",
    `@kiteline/${name}`,
    "deploy",
    "--prod",
    "--offline",
    "--config.inject-workspace-packages=true",
    ...(windowsAgent ? ["--config.node-linker=hoisted"] : []),
    target,
  ]);
  // Shared's real location determines the existing native-component paths.
  if (name !== "shared") {
    const link = join(target, "node_modules/@kiteline/shared");
    rmSync(link, { recursive: true, force: true });
    if (windowsAgent) {
      mkdirSync(link, { recursive: true });
      const { exports } = JSON.parse(readFileSync(join(root, "shared/package.json"), "utf8"));
      const forwarding = {};
      for (const [index, [key, source]] of Object.entries(exports).entries()) {
        const name = `export-${index}.js`;
        writeFileSync(join(link, name), `export * from "../../../../shared/${source.slice(2)}";\n`);
        forwarding[key] = `./${name}`;
      }
      writeFileSync(
        join(link, "package.json"),
        JSON.stringify({ name: "@kiteline/shared", type: "module", exports: forwarding }) + "\n",
      );
    } else symlinkSync("../../../shared", link);
  }
  if (windowsAgent) rmSync(join(target, "node_modules/.bin"), { recursive: true, force: true });
}
function checksums(directory) {
  const entries = [];
  const expectedELFs = new Set(
    staticAgent
      ? [
          "runtime/bin/node",
          "dist/native/bin/tmux",
          "dist/native/bin/rename-noreplace",
          "dist/native/bin/rg",
        ]
      : [],
  );
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        const name = relative(directory, file);
        const bytes = readFileSync(file);
        if (staticAgent) {
          if (name.endsWith(".node"))
            throw new Error(`Dynamic Node addon is not supported: ${name}`);
          if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
            if (!expectedELFs.delete(name)) throw new Error(`Unexpected agent ELF: ${name}`);
            if (!(stat.mode & 0o111)) throw new Error(`Agent ELF is not executable: ${name}`);
            if (
              /INTERP/.test(text("readelf", ["-l", file])) ||
              /NEEDED/.test(text("readelf", ["-d", file]))
            )
              throw new Error(`Dynamic dependency in static agent: ${name}`);
          }
        }
        entries.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
      } else if (windowsAgent) throw new Error(`Windows packages cannot contain links: ${file}`);
      else if ((staticAgent || macosAgent) && stat.isSymbolicLink()) {
        const target = realpathSync(file);
        if (target !== directory && !target.startsWith(directory + "/"))
          throw new Error(`Agent symlink escapes package: ${file}`);
      }
    }
  }
  walk(directory);
  if (expectedELFs.size) throw new Error(`Missing agent ELF: ${[...expectedELFs].join(", ")}`);
  writeFileSync(join(directory, "SHA256SUMS"), entries.join("\n") + "\n");
}
try {
  const sourceHash = sourceDigest();
  run("pnpm", ["build"]);
  const agents = kind === "server" ? await agentArchives(sourceHash) : [];
  mkdirSync(cache, { recursive: true });
  mkdirSync(output, { recursive: true });
  let runtime;
  let staticBuild;
  let windowsBuild;
  let macosBuild;
  const native = join(temporary, "native");
  if (windowsAgent) {
    const components = resolve(windowsComponents);
    windowsBuild = verifyWindowsComponents(components);
    runtime = join(components, "runtime");
    cpSync(join(components, "native"), native, { recursive: true });
  } else if (macosAgent) {
    const components = resolve(macosComponents);
    macosBuild = verifyMacosComponents(components);
    runtime = join(components, "runtime");
    cpSync(join(components, "native"), native, { recursive: true });
  } else if (staticAgent) {
    const components = join(temporary, "static");
    buildStaticAgent(components);
    runtime = join(components, "runtime");
    run("cp", ["-a", join(components, "native"), native]);
    staticBuild = JSON.parse(readFileSync(join(components, "build.json"), "utf8"));
  } else {
    const filename = `node-v${release.node}-linux-${node.architecture}.tar.xz`;
    const archive = join(cache, filename);
    if (!existsSync(archive) || digest(archive) !== node.sha256) {
      rmSync(archive, { force: true });
      const pending = `${archive}.${process.pid}.pending`;
      try {
        run("curl", [
          "--fail",
          "--location",
          "--output",
          pending,
          `https://nodejs.org/dist/v${release.node}/${filename}`,
        ]);
        if (digest(pending) !== node.sha256) throw new Error("Node archive checksum mismatch");
        renameSync(pending, archive);
      } finally {
        rmSync(pending, { force: true });
      }
    }
    run("tar", ["-xJf", archive, "-C", temporary]);
    runtime = join(temporary, filename.slice(0, -7));
  }
  if (staticAgent) {
    writeFileSync(
      join(native, "identity.json"),
      JSON.stringify(
        {
          linkage: "static-musl",
          node: `v${release.node}`,
          architecture: node.architecture,
          tmux: staticBuild.native.sources.tmux.version,
          tmuxSource: staticBuild.native.sources.tmux.sha256,
          patch: staticBuild.native.patch,
          helper: staticBuild.native.helper,
          terminfo: staticBuild.native.terminfo,
          terminfoResources: {
            modern: digest(join(native, "share/terminfo/t/tmux-256color")),
            legacy: digest(join(native, "share/terminfo-legacy/t/tmux-256color")),
          },
          tmuxBinary: digest(join(native, "bin/tmux")),
          helperBinary: digest(join(native, "bin/rename-noreplace")),
          ripgrep: prepareRipgrep(native),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (kind === "agent" && !windowsAgent && !macosAgent) {
    mkdirSync(native);
    const builder = `kiteline-native-builder:${arch}`;
    run("docker", [
      "build",
      "--platform",
      `linux/${arch}`,
      "--build-arg",
      `UBUNTU=${release.ubuntu}`,
      "--build-arg",
      `CA_CERTIFICATES_URL=${release.caCertificates.url}`,
      "--build-arg",
      `CA_CERTIFICATES_SHA256=${release.caCertificates.sha256}`,
      "--build-arg",
      "HTTP_PROXY",
      "--build-arg",
      "HTTPS_PROXY",
      "--build-arg",
      "NO_PROXY",
      "-t",
      builder,
      "-f",
      "deploy/Dockerfile.native",
      "deploy",
    ]);
    run("docker", [
      "run",
      "--rm",
      "--platform",
      `linux/${arch}`,
      "-e",
      "HTTP_PROXY",
      "-e",
      "HTTPS_PROXY",
      "-e",
      "NO_PROXY",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${root}:/src:ro`,
      "-v",
      `${runtime}:/runtime:ro`,
      "-v",
      `${native}:/output`,
      "-e",
      "KITELINE_NATIVE_OUTPUT=/output",
      "-e",
      "KITELINE_BUNDLE_LIBS=1",
      builder,
      "/runtime/bin/node",
      "/src/scripts/build-native.mjs",
    ]);
  }
  if (kind === "agent") {
    const recorder = JSON.parse(
      readFileSync(join(root, "terminal-recorder/package.json"), "utf8"),
    ).dependencies;
    const web = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8")).dependencies;
    const shared = JSON.parse(readFileSync(join(root, "shared/package.json"), "utf8")).dependencies;
    const { terminalProfile } = await import("../shared/dist/protocol/index.js");
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
  const sourceCommit = text("git", ["rev-parse", "HEAD"]);
  const sourceDirty = text("git", ["status", "--porcelain"]) !== "";
  const platform = windowsAgent ? "windows" : macosAgent ? "macos" : "linux";
  const name = `kiteline-${kind}-${version}-${platform}-${arch}`;
  const destination = join(temporary, name);
  mkdirSync(destination);
  deploy("shared", join(destination, "shared"));
  deploy(kind, join(destination, kind));
  if (kind === "agent") {
    deploy("terminal-recorder", join(destination, "terminal-recorder"));
    cpSync(native, join(destination, "dist/native"), { recursive: true });
    mkdirSync(join(destination, "deploy"));
    const manager = windowsAgent ? "xml" : macosAgent ? "plist" : "service";
    cpSync(
      join(root, `deploy/kiteline-agent.${manager}`),
      join(destination, `deploy/kiteline-agent.${manager}`),
    );
  } else {
    cpSync(join(root, "web/dist"), join(destination, "web/dist"), { recursive: true });
    const downloads = join(destination, "downloads");
    mkdirSync(downloads);
    for (const { archive, checksum } of agents)
      for (const file of [archive, checksum]) cpSync(file, join(downloads, basename(file)));
    cpSync(join(root, "deploy/install-agent.sh"), join(downloads, "install.sh"));
    cpSync(join(root, "deploy/install-agent.ps1"), join(downloads, "install.ps1"));
  }
  if (windowsAgent || macosAgent)
    cpSync(runtime, join(destination, "runtime"), { recursive: true });
  else if (staticAgent) run("cp", ["-a", runtime, join(destination, "runtime")]);
  else {
    mkdirSync(join(destination, "runtime/bin"), { recursive: true });
    cpSync(join(runtime, "bin/node"), join(destination, "runtime/bin/node"));
    cpSync(join(runtime, "LICENSE"), join(destination, "runtime/LICENSE"));
  }
  mkdirSync(join(destination, "bin"));
  const launcher = join(destination, "bin", `kiteline-${kind}${windowsAgent ? ".ps1" : ""}`);
  if (windowsAgent) {
    const nativeSource = readFileSync(join(root, "native/windows/launcher.cs"), "utf8");
    const type = `KitelineLauncher_${createHash("sha256").update(nativeSource).digest("hex").slice(0, 16)}`;
    const list = (values) =>
      "@(" + values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",") + ")";
    const required = [
      "SHA256SUMS",
      "release.json",
      "bin/kiteline-agent.ps1",
      "bin/kiteline-agent-installed.ps1",
      "agent/package.json",
      "agent/dist/main.js",
      "shared/package.json",
      "shared/dist/version.json",
      "shared/dist/protocol/index.js",
      "shared/dist/windows/native.js",
      "shared/dist/terminal/pane.js",
      "terminal-recorder/package.json",
      "terminal-recorder/dist/main.js",
      "dist/native/identity.json",
      ...windowsComponentFiles.map(windowsComponentPath),
    ];
    const template = readFileSync(join(root, "deploy/kiteline-agent.ps1"), "utf8")
      .replace("__KITELINE_REQUIRED_FILES__", list(required))
      .replace("__KITELINE_COMPONENT_FILES__", list(windowsComponentFiles))
      .replace("__KITELINE_NATIVE_SOURCE__", nativeSource)
      .replaceAll("__KITELINE_LAUNCHER_TYPE__", type);
    writeFileSync(
      launcher,
      template.replace(
        "__KITELINE_PACKAGE_ROOT__",
        "[IO.Directory]::GetParent($PSScriptRoot).FullName",
      ),
    );
    writeFileSync(
      join(destination, "bin/kiteline-agent-installed.ps1"),
      template.replace("__KITELINE_PACKAGE_ROOT__", "$program"),
    );
  } else if (kind === "agent") {
    const { agentLauncher } = await import("../agent/dist/launcher.js");
    const platform = macosAgent ? "darwin" : "linux";
    writeFileSync(launcher, agentLauncher(undefined, undefined, platform));
    writeFileSync(
      join(destination, "bin/kiteline-agent-installed"),
      agentLauncher("/opt/kiteline-agent", undefined, platform),
    );
    chmodSync(join(destination, "bin/kiteline-agent-installed"), 0o755);
  } else
    writeFileSync(
      launcher,
      `#!/bin/sh\nset -eu\nkiteline_root=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")\nexec "$kiteline_root/runtime/bin/node" "$kiteline_root/${kind}/dist/main.js" "$@"\n`,
    );
  chmodSync(launcher, 0o755);
  writeFileSync(
    join(destination, "release.json"),
    JSON.stringify(
      {
        version,
        kind,
        platform,
        architecture: node.architecture,
        node: release.node,
        sourceCommit,
        sourceDirty,
        sourceDigest: sourceHash,
        lockfile: digest(join(root, "pnpm-lock.yaml")),
        ...(windowsBuild
          ? { nodeArchive: windowsBuild.inputs.downloads["node.zip"].sha256 }
          : macosBuild
            ? { nodeArchive: macosBuild.inputs.downloads["node.tar.xz"].sha256 }
            : staticBuild
              ? { staticBuild }
              : {
                  nodeArchive: node.sha256,
                  ubuntu: release.ubuntu,
                  aptSources: digest(join(root, "deploy/ubuntu.sources")),
                  caCertificates: release.caCertificates,
                }),
      },
      null,
      2,
    ) + "\n",
  );
  checksums(destination);
  if (sourceDigest() !== sourceHash)
    throw new Error("Source changed during packaging; rerun the build");
  const extension = windowsAgent ? "zip" : "tar.gz";
  const tarball = join(output, `${name}.${extension}`);
  const staged = join(temporary, `${name}.${extension}`);
  if (windowsAgent) run("zip", ["-q", "-r", staged, name], { cwd: temporary });
  else run("tar", ["-czf", staged, "-C", temporary, name]);
  const pending = `${tarball}.${process.pid}.pending`;
  try {
    // Publish beside the destination so rename also works across cache filesystems.
    cpSync(staged, pending);
    writeFileSync(`${pending}.sha256`, `${digest(staged)}  ${name}.${extension}\n`);
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
