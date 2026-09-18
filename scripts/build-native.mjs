import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist/native");
const directory = mkdtempSync("/var/tmp/kiteline-native-");
const tarball = resolve(directory, "tmux.tar.gz");
const checksum = "551ab8dea0bf505c0ad6b7bb35ef567cdde0ccb84357df142c254f35a23e19aa";
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

try {
  mkdirSync(destination, { recursive: true });
  run("curl", [
    "--fail",
    "--location",
    "--output",
    tarball,
    "https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz",
  ]);
  if (digest(tarball) !== checksum) throw new Error("tmux source checksum mismatch");
  run("tar", ["-xzf", tarball]);
  const source = resolve(directory, "tmux-3.4");
  run("patch", ["-p1", "-i", resolve(root, "native/tmux-paste.patch")], source);
  run("./configure", ["--quiet", "--disable-sixel", `--prefix=${destination}`], source);
  run("make", ["-s", "-j2"], source);
  mkdirSync(resolve(destination, "bin"), { recursive: true });
  cpSync(resolve(source, "tmux"), resolve(destination, "bin/tmux"));
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
        node: process.version,
        architecture: process.arch,
        tmux: "3.4",
        tmuxSource: checksum,
        patch: digest(resolve(root, "native/tmux-paste.patch")),
        helper: digest(resolve(root, "native/rename-noreplace.c")),
        terminfo: digest(terminfoSource),
        tmuxBinary: digest(resolve(destination, "bin/tmux")),
        helperBinary: digest(resolve(destination, "bin/rename-noreplace")),
        helperFlags: ["-Wall", "-Wextra", "-Werror", "-O2"],
        configure: ["--disable-sixel"],
        headless: "6.1.0-beta.303",
        xterm: "6.1.0-beta.304",
        serialize: "0.15.0-beta.301",
        profile: "xterm-c1",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
