import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";
import { digest, fetchPinned, run as execute } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist/native");
const directory = mkdtempSync("/var/tmp/kiteline-native-");
const tarball = resolve(directory, "tmux.tar.gz");
const { tmux } = JSON.parse(readFileSync(resolve(root, "release/inputs.json"), "utf8"));
const checksum = tmux.sha256;
function run(command, args, cwd = directory) {
  return execute(command, args, { cwd });
}

try {
  mkdirSync(destination, { recursive: true });
  fetchPinned(tmux, tarball);
  run("tar", ["-xzf", tarball]);
  const source = resolve(directory, `tmux-${tmux.version}`);
  run("patch", ["-p1", "-i", resolve(root, "native/tmux/paste.patch")], source);
  run("patch", ["-p1", "-i", resolve(root, "native/tmux/flow-control.patch")], source);
  run("./configure", ["--quiet", "--disable-sixel", `--prefix=${destination}`], source);
  run("make", ["-s", "-j2"], source);
  mkdirSync(resolve(destination, "bin"), { recursive: true });
  cpSync(resolve(source, "tmux"), resolve(destination, "bin/tmux"));
  mkdirSync(resolve(destination, "licenses"), { recursive: true });
  cpSync(resolve(source, "COPYING"), resolve(destination, "licenses/tmux.txt"));
  const terminfoSource = resolve(root, "native/tmux/tmux.terminfo");
  mkdirSync(resolve(destination, "share/terminfo"), { recursive: true });
  run("tic", ["-x", "-o", resolve(destination, "share/terminfo"), terminfoSource]);
  run("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    resolve(root, "native/linux/rename-noreplace.c"),
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
        tmux: tmux.version,
        tmuxSource: checksum,
        patch: digest(resolve(root, "native/tmux/paste.patch")),
        flowControlPatch: digest(resolve(root, "native/tmux/flow-control.patch")),
        helper: digest(resolve(root, "native/linux/rename-noreplace.c")),
        terminfo: digest(terminfoSource),
        tmuxBinary: digest(resolve(destination, "bin/tmux")),
        helperBinary: digest(resolve(destination, "bin/rename-noreplace")),
        helperFlags: ["-Wall", "-Wextra", "-Werror", "-O2"],
        configure: ["--disable-sixel"],
        ripgrep: prepareRipgrep(destination, process.arch === "x64" ? "amd64" : process.arch),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
