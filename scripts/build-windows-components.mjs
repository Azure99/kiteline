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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowsNotices } from "./prepare-windows-notices.mjs";
import { requiredWindowsComponents } from "../shared/src/windows/components.ts";

const root = resolve(import.meta.dirname, "..");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const release = json(join(root, "deploy/release.json"));
const recipe = json(join(root, "deploy/agent-windows.json"));
const { tmux } = json(join(root, "deploy/agent-static.json"));
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceFiles = [
  "deploy/release.json",
  "deploy/agent-static.json",
  "deploy/agent-windows.json",
  "deploy/ubuntu.sources",
  "deploy/Dockerfile.windows-native",
  "scripts/build-windows-components.mjs",
  "scripts/build-windows-tmux.sh",
  "scripts/build-windows-addon.sh",
  "scripts/prepare-windows-notices.mjs",
  "deploy/windows-components.md",
  "shared/src/windows/components.ts",
  "native/tmux-paste.patch",
  "native/tmux-cygwin-outfd.patch",
  "native/tmux.terminfo",
  ...readdirSync(join(root, "native/windows"))
    .filter((file) => /\.(cc|hpp|def)$/.test(file))
    .sort()
    .map((file) => `native/windows/${file}`),
];
const downloads = {
  "node.zip": {
    url: `https://nodejs.org/dist/v${release.node}/node-v${release.node}-win-x64.zip`,
    sha256: recipe.nodeArchiveSha256,
  },
  "node-headers.tar.gz": {
    url: `https://nodejs.org/dist/v${release.node}/node-v${release.node}-headers.tar.gz`,
    sha256: recipe.nodeHeadersSha256,
  },
  "rg.zip": recipe.ripgrep,
  "msys2-base.tar.xz": recipe.bootstrap,
  "tmux.tar.gz": tmux,
  "licenses/PCRE2-LICENCE.md": release.ripgrep.pcre2License,
  ...Object.fromEntries(recipe.packages.map((pkg) => [`packages/${pkg.name}.tar.zst`, pkg])),
  ...Object.fromEntries(
    Object.entries(recipe.sources).map(([name, input]) => [`sources/${name}`, input]),
  ),
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}
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
function verifyInputs(directory) {
  const expected = inputs();
  if (hash(json(join(directory, "inputs.json"))) !== hash(expected))
    throw new Error("Windows component inputs do not match this source; prepare them again");
  for (const [file, input] of Object.entries(downloads))
    if (digest(join(directory, file)) !== input.sha256)
      throw new Error(`Windows component input checksum mismatch: ${file}`);
  for (const [file, sha256] of Object.entries(expected.files))
    if (digest(join(directory, file)) !== sha256)
      throw new Error(`Windows component recipe checksum mismatch: ${file}`);
  return expected;
}
function files(directory, prefix = "") {
  const entries = {};
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const key = prefix + name;
    const stat = lstatSync(file);
    if (stat.isDirectory()) Object.assign(entries, files(file, key + "/"));
    else if (stat.isFile()) entries[key] = digest(file);
    else throw new Error(`Windows components cannot contain links: ${file}`);
  }
  return entries;
}

export function prepareWindowsInputs(directory) {
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

export function buildWindowsTmux(directory, destination) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("tmux requires a Windows x64 build host");
  const expected = verifyInputs(directory);
  // A fresh private root avoids installed packages, shell profiles and rolling updates.
  mkdirSync(destination);
  const temporary = mkdtempSync(join(destination, "build-"));
  try {
    const tar = join(process.env.SystemRoot, "System32/tar.exe");
    run(tar, ["-xf", join(directory, "msys2-base.tar.xz"), "-C", temporary]);
    const msys = join(temporary, "msys64");
    for (const pkg of recipe.packages)
      run(tar, ["-xf", join(directory, "packages", `${pkg.name}.tar.zst`), "-C", msys]);
    const environment = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.SystemRoot,
      PATH: `${join(msys, "usr/bin")};${join(process.env.SystemRoot, "System32")}`,
      HOME: "/tmp",
      TMP: join(msys, "tmp"),
      TEMP: join(msys, "tmp"),
      MSYSTEM: "MSYS",
      MSYS2_ARG_CONV_EXCL: "*",
      MSYS2_ENV_CONV_EXCL: "*",
    };
    run(
      join(msys, "usr/bin/bash.exe"),
      [
        "--noprofile",
        "--norc",
        join(directory, "scripts/build-windows-tmux.sh").replaceAll("\\", "/"),
        directory,
        destination,
      ],
      { env: environment, cwd: temporary },
    );
    rmSync(join(destination, "source"), { recursive: true });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  writeJson(join(destination, "build.json"), {
    inputs: hash(expected),
    files: files(destination),
  });
}

export function buildWindowsAddon(directory, destination) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The fixed Windows addon builder requires Linux x64 and Docker");
  const expected = verifyInputs(directory);
  mkdirSync(destination);
  const image = "kiteline-windows-native-builder";
  run("docker", [
    "build",
    "--platform",
    "linux/amd64",
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
    image,
    "-f",
    join(directory, "deploy/Dockerfile.windows-native"),
    join(directory, "deploy"),
  ]);
  const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--platform",
    "linux/amd64",
    "-v",
    `${directory}:/inputs:ro`,
    "-v",
    `${destination}:/output`,
    imageId,
    "bash",
    "/inputs/scripts/build-windows-addon.sh",
  ]);
  writeJson(join(destination, "build.json"), {
    inputs: hash(expected),
    image: imageId,
    files: files(destination),
  });
}

function verifiedBuild(directory, expected) {
  const build = json(join(directory, "build.json"));
  const actual = files(directory);
  delete actual["build.json"];
  if (build.inputs !== hash(expected) || hash(build.files) !== hash(actual))
    throw new Error(`Windows component build is stale or damaged: ${directory}`);
  return build;
}

const requiredFiles = requiredWindowsComponents(downloads);

export function verifyWindowsComponents(directory) {
  const identity = json(join(directory, "native/identity.json"));
  if (hash(identity.inputs) !== hash(inputs()))
    throw new Error("Windows components do not match this source; rebuild them");
  const actual = files(directory);
  delete actual["native/identity.json"];
  for (const file of requiredFiles)
    if (!actual[file]) throw new Error(`Missing Windows component: ${file}`);
  if (hash(actual) !== hash(identity.files)) throw new Error("Windows component checksum mismatch");
  return identity;
}

export function assembleWindowsComponents(directory, tmuxDirectory, addonDirectory, destination) {
  const expected = verifyInputs(directory);
  const tmuxBuild = verifiedBuild(tmuxDirectory, expected);
  const addonBuild = verifiedBuild(addonDirectory, expected);
  mkdirSync(destination);
  const temporary = mkdtempSync("/var/tmp/kiteline-windows-assemble-");
  const native = join(destination, "native");
  try {
    run("unzip", [
      "-q",
      join(directory, "node.zip"),
      `node-v${release.node}-win-x64/node.exe`,
      `node-v${release.node}-win-x64/LICENSE`,
      "-d",
      temporary,
    ]);
    copy(
      join(temporary, `node-v${release.node}-win-x64/node.exe`),
      join(destination, "runtime/bin/node.exe"),
    );
    copy(
      join(temporary, `node-v${release.node}-win-x64/LICENSE`),
      join(destination, "runtime/LICENSE"),
    );
    run("unzip", ["-q", join(directory, "rg.zip"), "-d", temporary]);
    const rg = join(temporary, `ripgrep-${release.ripgrep.version}-x86_64-pc-windows-msvc`);
    copy(join(rg, "rg.exe"), join(native, "bin/rg.exe"));
    for (const file of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
      copy(join(rg, file), join(native, "licenses/ripgrep", file));
    for (const [pkg, paths] of Object.entries(recipe.runtimeFiles)) {
      const extracted = join(temporary, pkg);
      mkdirSync(extracted);
      run("tar", ["-xf", join(directory, "packages", `${pkg}.tar.zst`), "-C", extracted, ...paths]);
      for (const file of paths) copy(join(extracted, file), join(native, "msys", file));
    }
    copy(join(tmuxDirectory, "tmux.exe"), join(native, "msys/usr/bin/tmux.exe"));
    copy(
      join(tmuxDirectory, "terminfo/74/tmux-256color"),
      join(native, "msys/usr/share/terminfo/74/tmux-256color"),
    );
    copy(join(tmuxDirectory, "tmux-LICENSE"), join(native, "licenses/tmux.txt"));
    for (const directory of ["etc", "tmp"]) mkdirSync(join(native, "msys", directory));
    copy(join(addonDirectory, "kiteline-windows.node"), join(native, "kiteline-windows.node"));
    cpSync(join(addonDirectory, "licenses"), join(native, "licenses"), { recursive: true });
    prepareWindowsNotices(directory, native);
    copy(join(directory, "tmux.tar.gz"), join(native, "sources/tmux.tar.gz"));
    for (const file of sourceFiles)
      copy(join(directory, file), join(native, "sources/recipe", file));
    for (const [name, build] of [
      ["tmux", tmuxBuild],
      ["addon", addonBuild],
    ])
      writeJson(join(native, `sources/${name}-build.json`), build);
    for (const [from, file] of [
      [tmuxDirectory, "config.site"],
      [tmuxDirectory, "cmd-parse.c"],
      [addonDirectory, "build-packages.txt"],
      [addonDirectory, "addon.map"],
    ])
      copy(join(from, file), join(native, "sources", file));

    const componentFiles = files(destination);
    const binaries = new Set(
      Object.keys(componentFiles).map((name) => basename(name).toLowerCase()),
    );
    const systemDll =
      /^(?:advapi32|api-ms-win-core-synch-l1-2-0|bcryptprimitives|crypt32|dbghelp|iphlpapi|kernel32|msvcrt|ntdll|ole32|shell32|user32|userenv|winmm|ws2_32)\.dll$/i;
    for (const file of Object.keys(componentFiles).filter((file) =>
      /\.(exe|dll|node)$/.test(file),
    )) {
      const pe = run("objdump", ["-p", join(destination, file)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
      });
      for (const match of pe.matchAll(/DLL Name:\s*(\S+)/g))
        if (!systemDll.test(match[1]) && !binaries.has(match[1].toLowerCase()))
          throw new Error(`Unbundled Windows dependency: ${file} -> ${match[1]}`);
    }
    writeJson(join(native, "identity.json"), {
      linkage: "windows-msys",
      architecture: "x64",
      node: `v${release.node}`,
      tmux: tmux.version,
      tmuxSource: tmux.sha256,
      patch: expected.files["native/tmux-paste.patch"],
      controlPatch: expected.files["native/tmux-cygwin-outfd.patch"],
      terminfo: expected.files["native/tmux.terminfo"],
      ripgrep: { version: release.ripgrep.version, ...recipe.ripgrep },
      msysRuntime: recipe.packages.find((pkg) => pkg.name === "msys2-runtime").version,
      inputs: expected,
      files: componentFiles,
    });
    verifyWindowsComponents(destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output, addon, destination, extra] = process.argv.slice(2);
  if (
    !input ||
    extra ||
    (mode === "prepare" || mode === "verify" ? output : !output) ||
    (mode === "assemble" ? !addon || !destination : addon)
  )
    throw new Error(
      "Usage: node scripts/build-windows-components.mjs prepare INPUTS | tmux|addon INPUTS OUTPUT | assemble INPUTS TMUX ADDON OUTPUT | verify OUTPUT",
    );
  if (mode === "prepare") prepareWindowsInputs(resolve(input));
  else if (mode === "tmux") buildWindowsTmux(resolve(input), resolve(output));
  else if (mode === "addon") buildWindowsAddon(resolve(input), resolve(output));
  else if (mode === "assemble")
    assembleWindowsComponents(
      resolve(input),
      resolve(output),
      resolve(addon),
      resolve(destination),
    );
  else if (mode === "verify") verifyWindowsComponents(resolve(input));
  else throw new Error(`Unknown Windows component build: ${mode}`);
}
