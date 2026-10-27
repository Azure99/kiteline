import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";
import { fetchPinned, releaseCache, run as execute, tmuxPatchFiles } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist/native");
const directory = mkdtempSync("/var/tmp/kiteline-native-");
const { tmux, ripgrep } = JSON.parse(readFileSync(resolve(root, "release/inputs.json"), "utf8"));
const tarball = resolve(releaseCache, "static-sources", tmux.sha256);
function run(command, args, cwd = directory) {
  return execute(command, args, { cwd });
}

try {
  mkdirSync(destination, { recursive: true });
  fetchPinned(tmux, tarball);
  run("tar", ["-xzf", tarball]);
  const source = resolve(directory, `tmux-${tmux.version}`);
  for (const file of tmuxPatchFiles(root)) run("patch", ["-p1", "-i", resolve(root, file)], source);
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
  run("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    resolve(root, "native/terminal/pty-bridge.c"),
    "-lutil",
    "-o",
    resolve(destination, "bin/pty-bridge"),
  ]);
  prepareRipgrep(destination, process.arch === "x64" ? "amd64" : process.arch);
  writeFileSync(
    resolve(destination, "identity.json"),
    JSON.stringify(
      {
        linkage: "dynamic",
        node: process.version,
        architecture: process.arch,
        tmux: tmux.version,
        ripgrep: { version: ripgrep.version },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
