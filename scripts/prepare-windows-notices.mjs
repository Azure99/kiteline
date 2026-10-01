import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const notices = [
  ["bash", "bash-5.3.020-1", "bash-5.3.tar.gz", "bash-5.3", ["COPYING"]],
  ["readline", "readline-8.3.006-1", "readline-8.3.tar.gz", "readline-8.3", ["COPYING"]],
  ["coreutils", "coreutils-8.32-5", "coreutils-8.32.tar.xz", "coreutils-8.32", ["COPYING"]],
  [
    "util-linux",
    "util-linux-2.40.2-2",
    "util-linux-2.40.2.tar.xz",
    "util-linux-2.40.2",
    ["COPYING"],
  ],
  [
    "gettext",
    "gettext-0.22.5-1",
    "gettext-0.22.5.tar.gz",
    "gettext-0.22.5",
    ["COPYING", "gettext-runtime/intl/COPYING.LIB"],
  ],
  [
    "libiconv",
    "libiconv-1.19-1",
    "libiconv-1.19.tar.gz",
    "libiconv-1.19",
    ["COPYING", "COPYING.LIB"],
  ],
];
const read = (archive, path) =>
  execFileSync("tar", ["-xOf", archive, path], { maxBuffer: 64 * 1024 * 1024 });
function write(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

export function prepareWindowsNotices(directory, native) {
  const temporary = mkdtempSync("/var/tmp/kiteline-windows-notices-");
  try {
    for (const [name, archive, inner, prefix, paths] of notices) {
      const source = join(directory, "sources", archive + ".src.tar.zst");
      const upstream = join(temporary, inner);
      writeFileSync(upstream, read(source, name + "/" + inner));
      for (const path of paths)
        write(join(native, "licenses", name, path), read(upstream, prefix + "/" + path));
    }
    for (const name of ["libevent", "ncurses"])
      write(
        join(native, "licenses", name, "LICENSE"),
        read(
          join(directory, "packages", name + ".tar.zst"),
          "usr/share/licenses/" + name + "/LICENSE",
        ),
      );
    for (const name of ["COPYING", "CYGWIN_LICENSE"])
      write(
        join(native, "licenses/msys2-runtime", name),
        read(join(directory, "packages/msys2-runtime.tar.zst"), "usr/share/doc/Cygwin/" + name),
      );
    const sources = JSON.parse(
      readFileSync(join(directory, "deploy/agent-windows.json"), "utf8"),
    ).sources;
    mkdirSync(join(native, "sources"), { recursive: true });
    for (const name of Object.keys(sources))
      cpSync(join(directory, "sources", name), join(native, "sources", name));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
