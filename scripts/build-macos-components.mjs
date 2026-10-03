import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, fetchPinned, run } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const release = json(join(root, "release/inputs.json"));
const recipe = json(join(root, "release/agent-macos.json"));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceFiles = [
  "release/inputs.json",
  "release/agent-macos.json",
  "scripts/build-macos-components.mjs",
  "scripts/release-inputs.mjs",
  "scripts/build-macos-native.sh",
  "native/macos/rename-noreplace.c",
  "native/macos/entry-name.c",
  "native/tmux/paste.patch",
  "native/tmux/tmux.terminfo",
];
function downloads(architecture) {
  const target = recipe.architectures[architecture];
  if (!target) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  const nodeArchitecture = release.nodeArchives[architecture].architecture;
  return {
    "node.tar.xz": {
      url: `https://nodejs.org/dist/v${release.node}/node-v${release.node}-darwin-${nodeArchitecture}.tar.xz`,
      sha256: target.nodeArchiveSha256,
    },
    "tmux.tar.gz": release.tmux,
    "libevent.tar.gz": release.libevent,
    "flock.tar.gz": recipe.flock,
    "rg.tar.gz": target.ripgrep,
  };
}
const binaries = [
  "runtime/bin/node",
  ...["tmux", "rg", "flock", "rename-noreplace", "entry-name"].map((name) => `native/bin/${name}`),
];
const capture = (command, args) =>
  run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function sharedInputs(value, architecture) {
  return {
    node: value.node,
    nodeArchitecture: value.nodeArchives[architecture].architecture,
    tmux: value.tmux,
    libevent: value.libevent,
    ripgrepVersion: value.ripgrep.version,
  };
}
function inputs(architecture) {
  return {
    architecture,
    downloads: downloads(architecture),
    shared: sharedInputs(release, architecture),
    files: Object.fromEntries(
      sourceFiles
        .filter((file) => file !== "release/inputs.json")
        .map((file) => [file, digest(join(root, file))]),
    ),
  };
}
function files(directory, prefix = "") {
  const entries = {};
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const key = prefix + name;
    const stat = lstatSync(file);
    if (stat.isDirectory()) Object.assign(entries, files(file, key + "/"));
    else if (stat.isFile()) entries[key] = digest(file);
    else throw new Error(`Unexpected component link: ${file}`);
  }
  return entries;
}

export function prepareMacosInputs(directory, architecture) {
  const expected = inputs(architecture);
  mkdirSync(directory, { recursive: true });
  for (const [file, input] of Object.entries(expected.downloads))
    fetchPinned(input, join(directory, file));
  for (const file of sourceFiles) copy(join(root, file), join(directory, file));
  writeJson(join(directory, "inputs.json"), expected);
}

function macho(file, architecture) {
  if (
    capture("/usr/bin/lipo", ["-archs", file]) !== (architecture === "amd64" ? "x86_64" : "arm64")
  )
    throw new Error(`Unexpected Mach-O architecture: ${file}`);
  const commands = capture("/usr/bin/otool", ["-l", file]);
  const minimum =
    commands.match(/cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform 1\s+minos ([\d.]+)/)?.[1] ??
    commands.match(/cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)/)?.[1];
  const [major, minor] = (minimum ?? "").split(".").map(Number);
  const [targetMajor, targetMinor] = recipe.deploymentTarget.split(".").map(Number);
  if (!minimum || major > targetMajor || (major === targetMajor && minor > targetMinor))
    throw new Error(`Mach-O does not target macOS ${recipe.deploymentTarget}: ${file}`);
  const libraries = capture("/usr/bin/otool", ["-L", file])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (compatibility version ")[0]);
  for (const library of libraries)
    if (!/^\/(usr\/lib|System\/Library)\//.test(library))
      throw new Error(`Unbundled Mach-O dependency: ${file} -> ${library}`);
  return { minimum, libraries };
}

export function buildMacosComponents(directory, destination, architecture) {
  const expected = inputs(architecture);
  const nodeArchitecture = release.nodeArchives[architecture].architecture;
  if (process.platform !== "darwin" || process.arch !== nodeArchitecture)
    throw new Error(
      `The macOS ${architecture} component builder requires a Darwin ${nodeArchitecture} build host`,
    );
  if (hash(json(join(directory, "inputs.json"))) !== hash(expected))
    throw new Error("macOS component inputs do not match this source; prepare them again");
  for (const [file, input] of Object.entries(expected.downloads))
    if (digest(join(directory, file)) !== input.sha256)
      throw new Error(`macOS component input checksum mismatch: ${file}`);
  for (const [file, sha256] of Object.entries(expected.files))
    if (digest(join(directory, file)) !== sha256)
      throw new Error(`macOS component recipe checksum mismatch: ${file}`);
  const receipt = run(
    "/usr/sbin/pkgutil",
    ["--pkg-info-plist", "com.apple.pkg.CLTools_Executables"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const clt = JSON.parse(
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: receipt,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    }),
  )["pkg-version"];
  const toolchain = {
    clt,
    clang: capture("/usr/bin/clang", ["--version"]).split("\n")[0],
    sdk: capture("/usr/bin/xcrun", ["--show-sdk-version"]),
  };
  mkdirSync(destination);
  const temporary = mkdtempSync("/var/tmp/kiteline-macos-build-");
  try {
    run(
      "/bin/bash",
      [join(directory, "scripts/build-macos-native.sh"), directory, destination, temporary],
      {
        env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: recipe.deploymentTarget },
      },
    );
    run("/usr/bin/tar", ["-xf", join(directory, "node.tar.xz"), "-C", temporary]);
    const node = join(
      temporary,
      basename(new URL(expected.downloads["node.tar.xz"].url).pathname, ".tar.xz"),
    );
    copy(join(node, "bin/node"), join(destination, "runtime/bin/node"));
    copy(join(node, "LICENSE"), join(destination, "runtime/LICENSE"));
    run("/usr/bin/tar", ["-xf", join(directory, "rg.tar.gz"), "-C", temporary]);
    const rg = join(
      temporary,
      basename(new URL(expected.downloads["rg.tar.gz"].url).pathname, ".tar.gz"),
    );
    copy(join(rg, "rg"), join(destination, "native/bin/rg"));
    for (const file of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
      copy(join(rg, file), join(destination, "native/licenses/ripgrep", file));
    const linkage = Object.fromEntries(
      binaries.map((file) => [file, macho(join(destination, file), architecture)]),
    );
    if (capture(join(destination, "native/bin/tmux"), ["-V"]) !== `tmux ${release.tmux.version}`)
      throw new Error("macOS tmux version mismatch");
    writeJson(join(destination, "native/identity.json"), {
      linkage: "macos-system",
      architecture: nodeArchitecture,
      node: `v${release.node}`,
      tmux: release.tmux.version,
      libevent: recipe.libeventVersion,
      flock: recipe.flock.version,
      ripgrep: {
        version: release.ripgrep.version,
        ...expected.downloads["rg.tar.gz"],
        binarySha256: digest(join(destination, "native/bin/rg")),
      },
      toolchain,
      system: capture("/usr/bin/sw_vers", []),
      inputs: expected,
      binaries: linkage,
      files: files(destination),
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyMacosComponents(directory, architecture) {
  const native = join(directory, "native");
  const identity = json(join(native, "identity.json"));
  const expected = inputs(architecture);
  if (
    identity.architecture !== release.nodeArchives[architecture].architecture ||
    hash(identity.inputs) !== hash(expected)
  )
    throw new Error("macOS components do not match this source; rebuild them");
  const actual = files(directory);
  delete actual["native/identity.json"];
  for (const file of [...binaries, "runtime/LICENSE", "native/share/terminfo/74/tmux-256color"])
    if (!actual[file]) throw new Error(`Missing macOS component: ${file}`);
  if (hash(actual) !== hash(identity.files)) throw new Error("macOS component checksum mismatch");
  return identity;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, architecture, input, output, extra] = process.argv.slice(2);
  if (!input || extra || (mode === "build" ? !output : output))
    throw new Error(
      "Usage: node scripts/build-macos-components.mjs prepare amd64|arm64 INPUTS | build amd64|arm64 INPUTS OUTPUT | verify amd64|arm64 OUTPUT",
    );
  if (mode === "prepare") prepareMacosInputs(resolve(input), architecture);
  else if (mode === "build") buildMacosComponents(resolve(input), resolve(output), architecture);
  else if (mode === "verify") verifyMacosComponents(resolve(input), architecture);
  else throw new Error(`Unknown macOS component build: ${mode}`);
}
