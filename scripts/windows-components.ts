import { readFileSync } from "node:fs";

const recipe = JSON.parse(
  readFileSync(new URL("../release/agent-windows.json", import.meta.url), "utf8"),
) as { runtimeFiles: Record<string, string[]> };

export const windowsRuntimeFiles = [
  "runtime/bin/node.exe",
  "native/kiteline-windows.node",
  "native/bin/rg.exe",
  "native/msys/usr/bin/tmux.exe",
  "native/msys/usr/share/terminfo/74/tmux-256color",
  ...Object.values(recipe.runtimeFiles)
    .flat()
    .map((file) => `native/msys/${file}`),
];

export const windowsComponentPath = (file: string) =>
  file.startsWith("native/") ? "dist/" + file : file;
