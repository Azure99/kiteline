import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const read = (archive, path) =>
  execFileSync("tar", ["-xOf", archive, path], { maxBuffer: 64 * 1024 * 1024 });
function write(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

export function prepareWindowsNotices(directory, native) {
  const sources = JSON.parse(
    readFileSync(join(directory, "release/agent-windows.json"), "utf8"),
  ).sources;
  const temporary = mkdtempSync("/var/tmp/kiteline-windows-notices-");
  try {
    for (const [archive, { notice }] of Object.entries(sources)) {
      if (!notice) continue;
      const { name, archive: inner, prefix, paths } = notice;
      const source = join(directory, "sources", archive);
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
    mkdirSync(join(native, "sources"), { recursive: true });
    for (const name of Object.keys(sources))
      cpSync(join(directory, "sources", name), join(native, "sources", name));
    for (const path of ["native/msys/ctrl-c.patch", "scripts/build-windows-runtime.sh"])
      write(join(native, "sources/kiteline", path), readFileSync(join(directory, path)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
