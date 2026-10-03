export const windowsRuntimeFiles = [
  "runtime/bin/node.exe",
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
];

export const windowsComponentPath = (file: string) =>
  file.startsWith("native/") ? "dist/" + file : file;
