import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";
import { digest, fetchPinned, run as execute } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(process.env.KITELINE_NATIVE_OUTPUT ?? resolve(root, "dist/native"));
const directory = mkdtempSync("/var/tmp/kiteline-native-");
const tarball = resolve(directory, "tmux.tar.gz");
const { tmux } = JSON.parse(readFileSync(resolve(root, "deploy/agent-static.json"), "utf8"));
const checksum = tmux.sha256;
function run(command, args, cwd = directory) {
  return execute(command, args, { cwd });
}

try {
  mkdirSync(destination, { recursive: true });
  fetchPinned(tmux, tarball);
  run("tar", ["-xzf", tarball]);
  const source = resolve(directory, `tmux-${tmux.version}`);
  run("patch", ["-p1", "-i", resolve(root, "native/tmux-paste.patch")], source);
  run("./configure", ["--quiet", "--disable-sixel", `--prefix=${destination}`], source);
  run("make", ["-s", "-j2"], source);
  mkdirSync(resolve(destination, "bin"), { recursive: true });
  cpSync(resolve(source, "tmux"), resolve(destination, "bin/tmux"));
  mkdirSync(resolve(destination, "licenses"), { recursive: true });
  cpSync(resolve(source, "COPYING"), resolve(destination, "licenses/tmux.txt"));
  const libraries = {};
  if (process.env.KITELINE_BUNDLE_LIBS === "1") {
    const linked = spawnSync("ldd", [resolve(destination, "bin/tmux")], { encoding: "utf8" });
    if (linked.status !== 0 || linked.stdout.includes("not found"))
      throw new Error("tmux dynamic dependencies are unavailable");
    mkdirSync(resolve(destination, "lib"), { recursive: true });
    for (const match of linked.stdout.matchAll(
      /\s+(lib(?:event|tinfo|ncurses)[^\s]+) => (\/[^\s]+)/g,
    )) {
      copyFileSync(match[2], resolve(destination, "lib", match[1]));
      libraries[match[1]] = digest(match[2]);
    }
    run("patchelf", ["--set-rpath", "$ORIGIN/../lib", resolve(destination, "bin/tmux")]);
    for (const [name, file] of [
      ["libevent", "/usr/share/doc/libevent-dev/copyright"],
      ["ncurses", "/usr/share/doc/libncurses-dev/copyright"],
    ])
      cpSync(file, resolve(destination, "licenses", `${name}.txt`));
    const packages = spawnSync("dpkg-query", ["-W"], { encoding: "utf8" });
    if (packages.status !== 0) throw new Error("Cannot record native build packages");
    writeFileSync(resolve(destination, "build-packages.txt"), packages.stdout);
  }
  const terminfo = spawnSync("infocmp", ["-x", "tmux-256color"], { encoding: "utf8" });
  if (terminfo.status !== 0) throw new Error("Install ncurses-term for tmux-256color");
  const terminfoSource = resolve(directory, "tmux.terminfo");
  writeFileSync(terminfoSource, terminfo.stdout);
  mkdirSync(resolve(destination, "share/terminfo"), { recursive: true });
  run("tic", ["-x", "-o", resolve(destination, "share/terminfo"), terminfoSource]);
  run("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    resolve(root, "native/rename-noreplace.c"),
    "-o",
    resolve(destination, "bin/rename-noreplace"),
  ]);
  writeFileSync(
    resolve(destination, "identity.json"),
    JSON.stringify(
      {
        linkage: "dynamic",
        node: process.version,
        architecture: process.arch,
        libraries,
        tmux: tmux.version,
        tmuxSource: checksum,
        patch: digest(resolve(root, "native/tmux-paste.patch")),
        helper: digest(resolve(root, "native/rename-noreplace.c")),
        terminfo: digest(terminfoSource),
        tmuxBinary: digest(resolve(destination, "bin/tmux")),
        helperBinary: digest(resolve(destination, "bin/rename-noreplace")),
        helperFlags: ["-Wall", "-Wextra", "-Werror", "-O2"],
        configure: ["--disable-sixel"],
        ...(process.arch === "x64" ? { ripgrep: prepareRipgrep(destination) } : {}),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
