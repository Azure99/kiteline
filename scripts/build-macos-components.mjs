import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const release = json(join(root, "deploy/release.json"));
const recipe = json(join(root, "deploy/agent-macos.json"));
const unix = json(join(root, "deploy/agent-static.json"));
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceFiles = [
  "deploy/release.json",
  "deploy/agent-static.json",
  "deploy/agent-macos.json",
  "scripts/build-macos-components.mjs",
  "scripts/build-macos-native.sh",
  "native/macos/rename-noreplace.c",
  "native/macos/entry-name.c",
  "native/tmux-paste.patch",
  "native/tmux.terminfo",
  "native/tmux-terminfo-LICENSE",
];
const downloads = {
  "node.tar.xz": {
    url: `https://nodejs.org/dist/v${release.node}/node-v${release.node}-darwin-x64.tar.xz`,
    sha256: recipe.nodeArchiveSha256,
  },
  "tmux.tar.gz": unix.tmux,
  "libevent.tar.gz": unix.sources["libevent.tar.gz"],
  "flock.tar.gz": recipe.flock,
  "rg.tar.gz": recipe.ripgrep,
  "licenses/PCRE2-LICENCE.md": release.ripgrep.pcre2License,
};
const binaries = [
  "runtime/bin/node",
  ...["tmux", "rg", "flock", "rename-noreplace", "entry-name"].map((name) => `native/bin/${name}`),
];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}
const capture = (command, args) =>
  run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function inputs() {
  return {
    downloads,
    files: Object.fromEntries(sourceFiles.map((file) => [file, digest(join(root, file))])),
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

export function prepareMacosInputs(directory) {
  mkdirSync(directory, { recursive: true });
  for (const [file, input] of Object.entries(downloads)) {
    const target = join(directory, file);
    if (existsSync(target) && digest(target) === input.sha256) continue;
    mkdirSync(dirname(target), { recursive: true });
    const pending = `${target}.${process.pid}.pending`;
    try {
      run("curl", ["--fail", "--location", "--output", pending, input.url]);
      if (digest(pending) !== input.sha256) throw new Error(`Checksum mismatch: ${input.url}`);
      renameSync(pending, target);
    } finally {
      rmSync(pending, { force: true });
    }
  }
  for (const file of sourceFiles) copy(join(root, file), join(directory, file));
  writeJson(join(directory, "inputs.json"), inputs());
}

function macho(file) {
  if (capture("/usr/bin/lipo", ["-archs", file]) !== "x86_64")
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

export function buildMacosComponents(directory, destination) {
  if (process.platform !== "darwin" || process.arch !== "x64")
    throw new Error("The macOS x86_64 component builder requires a Darwin x64 build host");
  const expected = inputs();
  if (hash(json(join(directory, "inputs.json"))) !== hash(expected))
    throw new Error("macOS component inputs do not match this source; prepare them again");
  for (const [file, input] of Object.entries(downloads))
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
  if (hash(toolchain) !== hash(recipe.toolchain))
    throw new Error("Unexpected macOS build toolchain");
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
    const node = join(temporary, `node-v${release.node}-darwin-x64`);
    copy(join(node, "bin/node"), join(destination, "runtime/bin/node"));
    copy(join(node, "LICENSE"), join(destination, "runtime/LICENSE"));
    run("/usr/bin/tar", ["-xf", join(directory, "rg.tar.gz"), "-C", temporary]);
    const rg = join(temporary, `ripgrep-${release.ripgrep.version}-x86_64-apple-darwin`);
    copy(join(rg, "rg"), join(destination, "native/bin/rg"));
    for (const file of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
      copy(join(rg, file), join(destination, "native/licenses/ripgrep", file));
    copy(
      join(directory, "licenses/PCRE2-LICENCE.md"),
      join(destination, "native/licenses/ripgrep/PCRE2-LICENCE.md"),
    );
    const linkage = Object.fromEntries(
      binaries.map((file) => [file, macho(join(destination, file))]),
    );
    if (
      capture(join(destination, "runtime/bin/node"), ["--version"]) !== `v${release.node}` ||
      capture(join(destination, "native/bin/tmux"), ["-V"]) !== `tmux ${unix.tmux.version}` ||
      capture(join(destination, "native/bin/rg"), ["--version"]).split(/\s+/)[1] !==
        release.ripgrep.version
    )
      throw new Error("macOS component version mismatch");
    writeJson(join(destination, "native/identity.json"), {
      linkage: "macos-system",
      architecture: "x64",
      node: `v${release.node}`,
      tmux: unix.tmux.version,
      libevent: recipe.libeventVersion,
      flock: recipe.flock.version,
      ripgrep: {
        version: release.ripgrep.version,
        ...recipe.ripgrep,
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

export function verifyMacosComponents(directory, packaged = false) {
  const native = join(directory, packaged ? "dist/native" : "native");
  const identity = json(join(native, "identity.json"));
  if (hash(identity.inputs) !== hash(inputs()))
    throw new Error("macOS components do not match this source; rebuild them");
  const actual = packaged
    ? { ...files(native, "native/"), ...files(join(directory, "runtime"), "runtime/") }
    : files(directory);
  delete actual["native/identity.json"];
  for (const file of [...binaries, "runtime/LICENSE", "native/share/terminfo/74/tmux-256color"])
    if (!actual[file]) throw new Error(`Missing macOS component: ${file}`);
  if (hash(actual) !== hash(identity.files)) throw new Error("macOS component checksum mismatch");
  return identity;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output, extra] = process.argv.slice(2);
  if (!input || extra || (mode === "build" ? !output : output))
    throw new Error(
      "Usage: node scripts/build-macos-components.mjs prepare INPUTS | build INPUTS OUTPUT | verify OUTPUT",
    );
  if (mode === "prepare") prepareMacosInputs(resolve(input));
  else if (mode === "build") buildMacosComponents(resolve(input), resolve(output));
  else if (mode === "verify") verifyMacosComponents(resolve(input));
  else throw new Error(`Unknown macOS component build: ${mode}`);
}
