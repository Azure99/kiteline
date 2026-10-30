import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowsNotices } from "./prepare-windows-notices.mjs";
import { windowsRuntimeFiles } from "./windows-components.ts";
import {
  copy,
  digest,
  files,
  hash,
  json,
  prepareInputs,
  ripgrepInput,
  run,
  tmuxPatchFiles,
  verifyComponentFiles,
  verifyPreparedInputs,
  writeJson,
} from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const release = json(join(root, "release/inputs.json"));
const recipe = json(join(root, "release/agent-windows.json"));
const { tmux } = release;
const msysRuntime = recipe.packages.find((pkg) => pkg.name === "msys2-runtime");
const inputSourceFiles = [
  "release/inputs.json",
  "release/agent-windows.json",
  "release/ubuntu.sources",
  "release/Dockerfile.windows-native",
  "scripts/build-windows-components.mjs",
  "scripts/release-inputs.mjs",
  "scripts/build-windows-msys.sh",
  "scripts/build-windows-runtime.sh",
  "scripts/build-windows-addon.sh",
  "scripts/prepare-windows-notices.mjs",
  "scripts/windows-components.ts",
  "native/tmux/series",
  ...tmuxPatchFiles(root),
  "native/tmux/cygwin-outfd.patch",
  "native/msys/ctrl-c.patch",
  "native/tmux/tmux.terminfo",
  "native/terminal/pty-bridge.c",
  // This scan records input identity; build-windows-addon.sh lists the compilation units.
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
  "rg.zip": ripgrepInput(release.ripgrep.version, recipe.ripgrep),
  "msys2-base.tar.xz": recipe.bootstrap,
  "tmux.tar.gz": tmux,
  ...Object.fromEntries(recipe.packages.map((pkg) => [`packages/${pkg.name}.tar.zst`, pkg])),
  ...Object.fromEntries(
    Object.entries(recipe.sources).map(([name, input]) => [`sources/${name}`, input]),
  ),
};
function inputs() {
  return {
    downloads,
    files: Object.fromEntries(inputSourceFiles.map((file) => [file, digest(join(root, file))])),
  };
}
function verifyInputs(directory) {
  return verifyPreparedInputs(directory, inputs(), "Windows");
}

function prepareWindowsInputs(directory) {
  prepareInputs(directory, root, inputSourceFiles, inputs());
}

function buildWindowsMsys(directory, destination) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("MSYS components require a Windows x64 build host");
  const expected = verifyInputs(directory);
  // A fresh private root avoids installed packages, shell profiles and rolling updates.
  mkdirSync(destination);
  const temporary = mkdtempSync(join(destination, "build-"));
  try {
    const tar = join(process.env.SystemRoot, "System32/tar.exe");
    const sevenZip = join(process.env.ProgramFiles, "7-Zip/7z.exe");
    const bootstrap = join(temporary, "bootstrap");
    run(sevenZip, ["x", "-y", `-o${bootstrap}`, join(directory, "msys2-base.tar.xz")]);
    run(tar, ["-xf", join(bootstrap, "msys2-base.tar"), "-C", temporary]);
    const msys = join(temporary, "msys64");
    for (const pkg of recipe.packages) {
      run(sevenZip, [
        "x",
        "-tzstd",
        "-y",
        `-o${bootstrap}`,
        join(directory, "packages", `${pkg.name}.tar.zst`),
      ]);
      const archive = join(bootstrap, `${pkg.name}.tar`);
      run(tar, ["-xf", archive, "-C", msys]);
      rmSync(archive);
    }
    const runtimeSource = `msys2-runtime-${msysRuntime.version}.src.tar`;
    run(sevenZip, [
      "x",
      "-tzstd",
      "-y",
      `-o${bootstrap}`,
      join(directory, "sources", `${runtimeSource}.zst`),
    ]);
    run(tar, ["-xf", join(bootstrap, runtimeSource), "-C", temporary]);
    const runtimeRecipe = join(temporary, "msys2-runtime");
    const runtimeArchive = join(temporary, "runtime.tar");
    run("git", [
      `--git-dir=${join(runtimeRecipe, "msys2-runtime")}`,
      "archive",
      "--format=tar",
      `--output=${runtimeArchive}`,
      `cygwin-${msysRuntime.version.split("-")[0]}`,
    ]);
    mkdirSync(join(destination, "runtime-source"));
    run(tar, ["-xf", runtimeArchive, "-C", join(destination, "runtime-source")]);
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
        join(directory, "scripts/build-windows-msys.sh").replaceAll("\\", "/"),
        directory,
        destination,
        runtimeRecipe,
      ],
      { env: environment, cwd: temporary },
    );
    rmSync(join(destination, "source"), { recursive: true });
    rmSync(join(destination, "runtime-source"), { recursive: true });
    rmSync(join(destination, "runtime-build"), { recursive: true });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  writeJson(join(destination, "build.json"), {
    inputs: hash(expected),
    files: files(destination),
  });
}

function buildWindowsAddon(directory, destination) {
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
    join(directory, "release/Dockerfile.windows-native"),
    join(directory, "release"),
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

export function verifyWindowsComponents(directory) {
  const identity = json(join(directory, "native/identity.json"));
  if (hash(identity.inputs) !== hash(inputs()))
    throw new Error("Windows components do not match this source; rebuild them");
  verifyComponentFiles(directory, identity, windowsRuntimeFiles, "Windows");
  return identity;
}

function assembleWindowsComponents(directory, msysDirectory, addonDirectory, destination) {
  const expected = verifyInputs(directory);
  verifiedBuild(msysDirectory, expected);
  verifiedBuild(addonDirectory, expected);
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
    copy(join(msysDirectory, "tmux.exe"), join(native, "msys/usr/bin/tmux.exe"));
    copy(join(msysDirectory, "pty-bridge.exe"), join(native, "msys/usr/bin/pty-bridge.exe"));
    copy(join(msysDirectory, "msys-2.0.dll"), join(native, "msys/usr/bin/msys-2.0.dll"));
    copy(
      join(msysDirectory, "terminfo/74/tmux-256color"),
      join(native, "msys/usr/share/terminfo/74/tmux-256color"),
    );
    copy(join(msysDirectory, "tmux-LICENSE"), join(native, "licenses/tmux.txt"));
    for (const directory of ["etc", "tmp"]) mkdirSync(join(native, "msys", directory));
    copy(join(addonDirectory, "kiteline-windows.node"), join(native, "kiteline-windows.node"));
    copy(
      join(addonDirectory, "kiteline-agent.exe"),
      join(destination, "command/kiteline-agent.exe"),
    );
    cpSync(join(addonDirectory, "licenses"), join(native, "licenses"), { recursive: true });
    prepareWindowsNotices(directory, native);

    const componentFiles = files(destination);
    for (const file of windowsRuntimeFiles)
      if (!componentFiles[file]) throw new Error(`Missing Windows component: ${file}`);
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
      patch: expected.files["native/tmux/paste.patch"],
      controlPatch: expected.files["native/tmux/cygwin-outfd.patch"],
      terminfo: expected.files["native/tmux/tmux.terminfo"],
      ripgrep: { version: release.ripgrep.version, ...expected.downloads["rg.zip"] },
      msysRuntime: msysRuntime.version,
      runtimePatch: expected.files["native/msys/ctrl-c.patch"],
      inputs: expected,
      files: componentFiles,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...positionals] = process.argv.slice(2);
  const [first, second, third, fourth, extra] = positionals;
  if (
    !first ||
    extra ||
    (mode === "prepare" ? second : !second) ||
    (mode === "assemble" ? !third || !fourth : third)
  )
    throw new Error(
      "Usage: node scripts/build-windows-components.mjs prepare INPUTS | tmux|addon INPUTS OUTPUT | assemble INPUTS TMUX ADDON OUTPUT",
    );
  if (mode === "prepare") {
    const [inputsDirectory] = positionals;
    prepareWindowsInputs(resolve(inputsDirectory));
  } else if (mode === "tmux") {
    const [inputsDirectory, msysDirectory] = positionals;
    buildWindowsMsys(resolve(inputsDirectory), resolve(msysDirectory));
  } else if (mode === "addon") {
    const [inputsDirectory, addonDirectory] = positionals;
    buildWindowsAddon(resolve(inputsDirectory), resolve(addonDirectory));
  } else if (mode === "assemble") {
    const [inputsDirectory, msysDirectory, addonDirectory, componentsDirectory] = positionals;
    assembleWindowsComponents(
      resolve(inputsDirectory),
      resolve(msysDirectory),
      resolve(addonDirectory),
      resolve(componentsDirectory),
    );
  } else throw new Error(`Unknown Windows component build: ${mode}`);
}
