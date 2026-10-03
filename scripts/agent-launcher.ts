import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The shell parses the whole function before maintenance replaces or removes the launcher.
const template = readFileSync(
  new URL("../installer/kiteline-agent.in.sh", import.meta.url),
  "utf8",
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function agentLauncher(
  source: string | undefined,
  paths: { directory: string; management: string; use: string },
  platform: NodeJS.Platform = process.platform,
) {
  const macos = platform === "darwin";
  const root = source
    ? `kiteline_root=${quote(source)}`
    : macos
      ? `kiteline_entry=$(readlink -f -- "$0") || return
  kiteline_root=$(dirname -- "$(dirname -- "$kiteline_entry")")`
      : 'kiteline_root=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")';
  const values: Record<string, string> = {
    __KITELINE_ROOT__: root,
    __KITELINE_FLOCK__: macos ? '"$kiteline_root/dist/native/bin/flock"' : "flock",
    __KITELINE_INSTALLED__: quote(paths.directory),
    __KITELINE_MANAGEMENT__: quote(paths.management),
    __KITELINE_USE__: quote(paths.use),
  };
  return template.replace(
    /__KITELINE_(ROOT|FLOCK|INSTALLED|MANAGEMENT|USE)__/g,
    (token) => values[token]!,
  );
}

export function windowsAgentLaunchers(runtimeFiles: readonly string[]) {
  const nativeSource = readFileSync(
    new URL("../installer/launcher.in.cs", import.meta.url),
    "utf8",
  );
  const type = `KitelineLauncher_${createHash("sha256").update(nativeSource).digest("hex").slice(0, 16)}`;
  const required = [
    "SHA256SUMS",
    "release.json",
    "bin/kiteline-agent.ps1",
    "bin/kiteline-agent-installed.ps1",
    "agent/package.json",
    "agent/dist/main.js",
    "shared/package.json",
    "shared/dist/version.json",
    "shared/dist/protocol/index.js",
    "shared/dist/windows/native.js",
    "shared/dist/terminal/pane.js",
    "terminal-recorder/package.json",
    "terminal-recorder/dist/main.js",
    "dist/native/identity.json",
    ...runtimeFiles,
  ];
  const list = "@(" + required.map((value) => `'${value.replaceAll("'", "''")}'`).join(",") + ")";
  const template = readFileSync(
    new URL("../installer/kiteline-agent.in.ps1", import.meta.url),
    "utf8",
  )
    .replace("__KITELINE_REQUIRED_FILES__", list)
    .replace("__KITELINE_NATIVE_SOURCE__", nativeSource)
    .replaceAll("__KITELINE_LAUNCHER_TYPE__", type);
  return {
    portable: template.replace(
      "__KITELINE_PACKAGE_ROOT__",
      "[IO.Directory]::GetParent($PSScriptRoot).FullName",
    ),
    installed: template.replace("__KITELINE_PACKAGE_ROOT__", "$program"),
  };
}
