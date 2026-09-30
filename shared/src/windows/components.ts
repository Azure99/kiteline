export const windowsComponentFiles = [
  "runtime/bin/node.exe",
  "runtime/LICENSE",
  "native/kiteline-windows.node",
  "native/bin/rg.exe",
  ...[
    "tmux.exe",
    "bash.exe",
    "sh.exe",
    "script.exe",
    "stty.exe",
    "cygwin-console-helper.exe",
    "msys-2.0.dll",
    "msys-event_core-2-1-7.dll",
    "msys-ncursesw6.dll",
    "msys-intl-8.dll",
    "msys-iconv-2.dll",
  ].map((name) => `native/msys/usr/bin/${name}`),
  "native/msys/usr/share/terminfo/74/tmux-256color",
  "native/msys/usr/share/terminfo/78/xterm-256color",
  "native/licenses/tmux.txt",
  "native/licenses/gcc-mingw-w64.txt",
  "native/licenses/mingw-w64.txt",
  "native/licenses/msys2-runtime/CYGWIN_LICENSE",
  "native/licenses/bash/COPYING",
  "native/licenses/readline/COPYING",
  "native/licenses/coreutils/COPYING",
  "native/licenses/util-linux/term-utils/script.c",
  "native/licenses/gettext/gettext-runtime/intl/COPYING.LIB",
  "native/licenses/libiconv/COPYING.LIB",
  "native/licenses/libevent/LICENSE",
  "native/licenses/ncurses/COPYING",
  "native/licenses/ripgrep/LICENSE-MIT",
  "native/licenses/ripgrep/PCRE2-LICENCE.md",
  "native/sources/tmux.tar.gz",
  "native/sources/recipe/deploy/agent-windows.json",
];

export function requiredWindowsComponents(downloads: Record<string, unknown>) {
  const sources = Object.keys(downloads).filter((file) => file.startsWith("sources/"));
  if (!sources.length)
    throw new Error("Windows component identity has no corresponding source catalog");
  return [...windowsComponentFiles, ...sources.map((file) => "native/" + file)];
}
