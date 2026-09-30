import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Keep upstream notices intact, including bundled/static code and per-file exceptions.
const notices = [
  [
    "bash",
    "bash-5.3.020-1",
    "bash-5.3.tar.gz",
    "bash-5.3",
    ["COPYING", "AUTHORS", "README", "lib/readline/COPYING", "lib/readline/README"],
  ],
  ["readline", "readline-8.3.006-1", "readline-8.3.tar.gz", "readline-8.3", ["COPYING", "README"]],
  [
    "coreutils",
    "coreutils-8.32-5",
    "coreutils-8.32.tar.xz",
    "coreutils-8.32",
    ["COPYING", "AUTHORS"],
  ],
  [
    "util-linux",
    "util-linux-2.40.2-2",
    "util-linux-2.40.2.tar.xz",
    "util-linux-2.40.2",
    [
      "COPYING",
      "README.licensing",
      "Documentation/licenses/COPYING.BSD-4-Clause-UC",
      "Documentation/licenses/COPYING.BSD-3-Clause",
      "Documentation/licenses/COPYING.BSD-2-Clause",
      "Documentation/licenses/COPYING.ISC",
      "Documentation/licenses/COPYING.MIT",
      "Documentation/licenses/COPYING.LGPL-2.1-or-later",
      "term-utils/script.c",
      "lib/pty-session.c",
    ],
  ],
  [
    "gettext",
    "gettext-0.22.5-1",
    "gettext-0.22.5.tar.gz",
    "gettext-0.22.5",
    [
      "COPYING",
      "gettext-runtime/intl/COPYING.LIB",
      "gettext-runtime/intl/AUTHORS",
      "gettext-runtime/intl/README",
    ],
  ],
  [
    "libiconv",
    "libiconv-1.19-1",
    "libiconv-1.19.tar.gz",
    "libiconv-1.19",
    ["COPYING", "COPYING.LIB", "AUTHORS", "libcharset/COPYING.LIB", "libcharset/AUTHORS"],
  ],
  [
    "libevent",
    "libevent-2.1.13-1",
    "libevent-2.1.13-stable.tar.gz",
    "libevent-2.1.13-stable",
    ["LICENSE"],
  ],
  [
    "ncurses",
    "ncurses-6.6-2",
    "ncurses-6.6.tar.gz",
    "ncurses-6.6",
    ["COPYING", "AUTHORS", "misc/terminfo.src"],
  ],
];
const read = (command, args) => execFileSync(command, args, { maxBuffer: 64 * 1024 * 1024 });
function write(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
function checkRecipe(directory, component, archive, recipeBytes) {
  const binary =
    component === "gettext" ? "libintl" : component === "readline" ? "libreadline" : component;
  const build = read("tar", [
    "-xOf",
    join(directory, "packages", binary + ".tar.zst"),
    ".BUILDINFO",
  ]);
  const expected = /^pkgbuild_sha256sum = (\w+)$/m.exec(build.toString())?.[1];
  if (createHash("sha256").update(recipeBytes).digest("hex") !== expected)
    throw new Error(`Source recipe does not match binary BUILDINFO: ${archive}`);
  return build;
}

export function prepareWindowsNotices(directory, native) {
  const temporary = mkdtempSync("/var/tmp/kiteline-windows-notices-");
  try {
    for (const [name, archive, inner, prefix, paths] of notices) {
      const source = join(directory, "sources", archive + ".src.tar.zst");
      const upstream = join(temporary, inner);
      writeFileSync(upstream, read("tar", ["-xOf", source, name + "/" + inner]));
      const recipe = read("tar", ["-xOf", source, name + "/PKGBUILD"]);
      write(
        join(native, "licenses", name, "BUILDINFO"),
        checkRecipe(directory, name, archive, recipe),
      );
      for (const path of paths)
        write(
          join(native, "licenses", name, path),
          read("tar", ["-xOf", upstream, prefix + "/" + path]),
        );
    }
    const runtime = join(directory, "sources/msys2-runtime-3.6.10-4.src.tar.zst");
    execFileSync("tar", ["-xf", runtime, "-C", temporary]);
    const source = join(temporary, "msys2-runtime");
    write(
      join(native, "licenses/msys2-runtime/BUILDINFO"),
      checkRecipe(directory, "msys2-runtime", runtime, readFileSync(join(source, "PKGBUILD"))),
    );
    for (const name of ["COPYING", "CYGWIN_LICENSE"])
      write(
        join(native, "licenses/msys2-runtime", name),
        read("tar", [
          "-xOf",
          join(directory, "packages/msys2-runtime.tar.zst"),
          "usr/share/doc/Cygwin/" + name,
        ]),
      );
    for (const name of ["winsup/COPYING.LIB", "COPYING.NEWLIB", "COPYING.LIBGLOSS"])
      write(
        join(native, "licenses/msys2-runtime", name),
        read("git", [
          "--git-dir=" + join(source, "msys2-runtime"),
          "show",
          "cygwin-3.6.10:" + name,
        ]),
      );
    const sources = JSON.parse(
      readFileSync(join(directory, "deploy/agent-windows.json"), "utf8"),
    ).sources;
    for (const name of Object.keys(sources)) {
      mkdirSync(join(native, "sources"), { recursive: true });
      cpSync(join(directory, "sources", name), join(native, "sources", name));
    }
    cpSync(
      join(directory, "licenses/PCRE2-LICENCE.md"),
      join(native, "licenses/ripgrep/PCRE2-LICENCE.md"),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
