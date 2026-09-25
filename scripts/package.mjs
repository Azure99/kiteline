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
import { parseArgs } from "node:util";
import { buildStaticAgent } from "./build-agent-static.mjs";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(join(root, "deploy/release.json"), "utf8"));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "agent-arch": { type: "string" } },
});
const [kind, arch] = positionals;
const agentArch = values["agent-arch"];
if (
  positionals.length !== 2 ||
  !["server", "agent"].includes(kind) ||
  !Object.hasOwn(release.nodeArchives, arch ?? "") ||
  (agentArch !== undefined &&
    (kind !== "server" || !Object.hasOwn(release.nodeArchives, agentArch)))
)
  throw new Error(
    "Usage: pnpm package agent|server amd64|arm64 [--agent-arch=amd64|arm64 (server only)]",
  );
const node = release.nodeArchives[arch];
const staticAgent = kind === "agent" && arch === "amd64";
const { version } = JSON.parse(readFileSync(join(root, "shared/src/version.json"), "utf8"));
const output = join(root, "dist/releases");
const cache = "/var/tmp/kiteline-release-cache";
const temporary = mkdtempSync("/var/tmp/kiteline-package-");
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
function agentArchives(sourceHash) {
  return Object.entries(release.nodeArchives)
    .filter(([architecture]) => agentArch === undefined || architecture === agentArch)
    .map(([architecture, runtime]) => {
      const name = `kiteline-agent-${version}-linux-${architecture}`;
      const archive = join(output, `${name}.tar.gz`);
      const checksum = archive + ".sha256";
      if (!existsSync(archive) || !existsSync(checksum))
        throw new Error(`Build agent ${architecture} first`);
      if (digest(archive) !== readFileSync(checksum, "utf8").trim().split(/\s+/)[0])
        throw new Error(`Agent archive checksum mismatch: ${architecture}`);
      const manifest = JSON.parse(text("tar", ["-xOf", archive, `${name}/release.json`]));
      if (
        manifest.kind !== "agent" ||
        manifest.version !== version ||
        manifest.architecture !== runtime.architecture ||
        manifest.sourceDigest !== sourceHash
      )
        throw new Error(
          `Agent ${architecture} must match this source/version/architecture; rebuild it`,
        );
      return { archive, checksum };
    });
}
function deploy(name, target) {
  run("pnpm", [
    "--filter",
    `@kiteline/${name}`,
    "deploy",
    "--prod",
    "--offline",
    "--config.inject-workspace-packages=true",
    target,
  ]);
  // Shared's real location determines the existing native-component paths.
  if (name !== "shared") {
    const link = join(target, "node_modules/@kiteline/shared");
    rmSync(link, { recursive: true, force: true });
    symlinkSync("../../../shared", link);
  }
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
      } else if (staticAgent && stat.isSymbolicLink()) {
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
  const agents = kind === "server" ? agentArchives(sourceHash) : [];
  mkdirSync(cache, { recursive: true });
  mkdirSync(output, { recursive: true });
  let runtime;
  let staticBuild;
  const native = join(temporary, "native");
  if (staticAgent) {
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
  run("pnpm", ["build"]);
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
  } else if (kind === "agent") {
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
          profile: terminalProfile,
        },
        null,
        2,
      ) + "\n",
    );
  }
  const sourceCommit = text("git", ["rev-parse", "HEAD"]);
  const sourceDirty = text("git", ["status", "--porcelain"]) !== "";
  const name = `kiteline-${kind}-${version}-linux-${arch}`;
  const destination = join(temporary, name);
  mkdirSync(destination);
  deploy("shared", join(destination, "shared"));
  deploy(kind, join(destination, kind));
  if (kind === "agent") {
    deploy("terminal-recorder", join(destination, "terminal-recorder"));
    cpSync(native, join(destination, "dist/native"), { recursive: true });
    mkdirSync(join(destination, "deploy"));
    cpSync(
      join(root, "deploy/kiteline-agent.service"),
      join(destination, "deploy/kiteline-agent.service"),
    );
  } else {
    cpSync(join(root, "web/dist"), join(destination, "web/dist"), { recursive: true });
    const downloads = join(destination, "downloads");
    mkdirSync(downloads);
    for (const { archive, checksum } of agents)
      for (const file of [archive, checksum]) cpSync(file, join(downloads, basename(file)));
    cpSync(join(root, "deploy/install-agent.sh"), join(downloads, "install.sh"));
  }
  if (staticAgent) run("cp", ["-a", runtime, join(destination, "runtime")]);
  else {
    mkdirSync(join(destination, "runtime/bin"), { recursive: true });
    cpSync(join(runtime, "bin/node"), join(destination, "runtime/bin/node"));
    cpSync(join(runtime, "LICENSE"), join(destination, "runtime/LICENSE"));
  }
  mkdirSync(join(destination, "bin"));
  const launcher = join(destination, "bin", `kiteline-${kind}`);
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
        architecture: node.architecture,
        node: release.node,
        sourceCommit,
        sourceDirty,
        sourceDigest: sourceHash,
        lockfile: digest(join(root, "pnpm-lock.yaml")),
        ...(staticBuild
          ? { staticBuild }
          : {
              nodeArchive: node.sha256,
              ubuntu: release.ubuntu,
              aptSources: digest(join(root, "deploy/ubuntu.sources")),
              caCertificates: release.caCertificates,
            }),
        native:
          kind === "agent"
            ? JSON.parse(readFileSync(join(native, "identity.json"), "utf8"))
            : undefined,
      },
      null,
      2,
    ) + "\n",
  );
  checksums(destination);
  if (sourceDigest() !== sourceHash)
    throw new Error("Source changed during packaging; rerun the build");
  const tarball = join(output, `${name}.tar.gz`);
  const staged = join(temporary, `${name}.tar.gz`);
  run("tar", ["-czf", staged, "-C", temporary, name]);
  const pending = `${tarball}.${process.pid}.pending`;
  try {
    // Publish beside the destination so rename also works across cache filesystems.
    cpSync(staged, pending);
    writeFileSync(`${pending}.sha256`, `${digest(staged)}  ${name}.tar.gz\n`);
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
