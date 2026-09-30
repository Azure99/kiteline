import type { IncomingMessage, ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, appVersion } from "@kiteline/shared/protocol";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const windowsLauncher = "(Join-Path $env:ProgramData 'kiteline-agent/kiteline-agent.ps1')";
function powershellCommand(url: string, arguments_: string) {
  return `& { $ErrorActionPreference = 'Stop'; $kitelinePolicy = Get-ExecutionPolicy -Scope Process; $kitelineScript = Join-Path ([IO.Path]::GetTempPath()) ('kiteline-connect-' + [Guid]::NewGuid().ToString('N') + '.ps1'); try { Set-ExecutionPolicy -Scope Process Bypass -Force; Invoke-WebRequest -Uri ${psQuote(url)} -OutFile $kitelineScript; & $kitelineScript ${arguments_} } finally { try { if ([IO.File]::Exists($kitelineScript)) { [IO.File]::Delete($kitelineScript) } } finally { Set-ExecutionPolicy -Scope Process $kitelinePolicy -Force } } }`;
}
function curlCommand(entryOrigin: string) {
  const protocols = entryOrigin.startsWith("https:") ? "=https" : "=http,https";
  return `curl -fsSL --proto '${protocols}' --proto-redir '${protocols}'`;
}

export function installationCommands(entryOrigin: string, code: string) {
  const origin = quote(entryOrigin);
  const bind = `kiteline-agent check && printf '%s\\n' ${quote(code)} | kiteline-agent bind --server ${origin} --if-unbound`;
  const install = (platform: "linux" | "macos") =>
    `${curlCommand(entryOrigin)} ${quote(entryOrigin + "/connect.sh")} | sh -s -- ${platform} ${quote(code)}`;
  return {
    linux: { install: install("linux"), bind },
    macos: { install: install("macos"), bind },
    windows: {
      install: powershellCommand(
        entryOrigin + "/connect.ps1",
        `-Version ${psQuote(appVersion)} -Code ${psQuote(code)}`,
      ),
      bind: `& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -ExecutionPolicy Bypass -File ${windowsLauncher} check; if ($LASTEXITCODE -eq 0) { ${psQuote(code)} | & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -ExecutionPolicy Bypass -File ${windowsLauncher} bind --server ${psQuote(entryOrigin)} --if-unbound }`,
    },
  };
}

function connectionScript(entryOrigin: string) {
  return `#!/bin/sh
set -eu

connect() {
    if [ "$#" -ne 2 ]; then
        echo 'Usage: sh -s -- PLATFORM CODE' >&2
        exit 1
    fi
    [ -n "$2" ] || { echo 'Missing binding code; generate a connection command in the web app' >&2; exit 1; }
    for kiteline_tool in curl mktemp; do
        command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; install curl, CA certificates and core utilities using your system package manager, then run this command again" >&2; exit 1; }
    done
    kiteline_install=$(mktemp /var/tmp/kiteline-install.XXXXXX)
    trap 'rm -f "$kiteline_install"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    ${curlCommand(entryOrigin)} ${quote(entryOrigin + "/install.sh")} -o "$kiteline_install"
    sh "$kiteline_install" --server ${quote(entryOrigin)} --version ${quote(appVersion)} --platform "$1" --code "$2"
}

connect "$@"
`;
}

export function upgradeCommand(entryOrigin: string) {
  const unix = (platform: "linux" | "macos") =>
    `(kiteline_script=$(${curlCommand(entryOrigin)} ${quote(entryOrigin + "/upgrade.sh")}) && sh -c "$kiteline_script" -- --version ${quote(appVersion)} --platform ${platform})`;
  return {
    version: appVersion,
    commands: {
      linux: unix("linux"),
      macos: unix("macos"),
      windows: powershellCommand(entryOrigin + "/upgrade.ps1", `-Version ${psQuote(appVersion)}`),
    },
  };
}

function windowsScript(entryOrigin: string, mode: "Connect" | "Upgrade") {
  return `param([string]$Version, [string]$Code)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Use PowerShell 7 on Windows' }
if ($Version -cne ${psQuote(appVersion)}) { throw 'The server release changed; obtain a new command from the web app' }
$kitelineInstaller = Join-Path ([IO.Path]::GetTempPath()) ('kiteline-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
    Invoke-WebRequest -Uri ${psQuote(entryOrigin + "/install.ps1")} -OutFile $kitelineInstaller
    & $kitelineInstaller -Mode ${mode} -Server ${psQuote(entryOrigin)} -Version $Version -Code $Code
} finally { if ([IO.File]::Exists($kitelineInstaller)) { [IO.File]::Delete($kitelineInstaller) } }
`;
}

function upgradeScript(entryOrigin: string) {
  return `#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = --version ] && [ "$2" = ${quote(appVersion)} ] && [ "$3" = --platform ] || { echo 'The server release changed; obtain a new upgrade command from the web app' >&2; exit 1; }
kiteline_platform=$4
[ -t 0 ] || { echo 'Run this command in an interactive terminal or SSH session on the target device' >&2; exit 1; }
for kiteline_tool in curl mktemp uname id; do
  command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; install curl, CA certificates and core utilities using your system package manager, then run this command again" >&2; exit 1; }
done
case "$kiteline_platform:$(uname -s)" in
  linux:Linux|macos:Darwin) ;;
  *) echo 'Selected platform does not match this device' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) kiteline_arch=amd64 ;;
  aarch64|arm64) kiteline_arch=arm64 ;;
  *) echo 'No agent archive is available for this architecture' >&2; exit 1 ;;
esac
[ -x /usr/local/bin/kiteline-agent ] || { echo 'Install and bind the agent before upgrading' >&2; exit 1; }
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo 'The upgrade requires sudo or root' >&2; exit 1; }
fi
kiteline_upgrade=$(mktemp -d /var/tmp/kiteline-agent-upgrade.XXXXXX)
trap 'rm -rf "$kiteline_upgrade"' EXIT
kiteline_interrupted=0
trap 'kiteline_interrupted=129' HUP
trap 'kiteline_interrupted=130' INT
trap 'kiteline_interrupted=143' TERM
kiteline_name="kiteline-agent-${appVersion}-$kiteline_platform-$kiteline_arch.tar.gz"
kiteline_base=${quote(entryOrigin + "/downloads/agent/" + appVersion + "/")}"$kiteline_name"
${curlCommand(entryOrigin)} "$kiteline_base" -o "$kiteline_upgrade/$kiteline_name"
${curlCommand(entryOrigin)} "$kiteline_base.sha256" -o "$kiteline_upgrade/$kiteline_name.sha256"
[ "$kiteline_interrupted" -eq 0 ] || exit "$kiteline_interrupted"
kiteline_result=0
if [ "$(id -u)" -eq 0 ]; then
  /usr/local/bin/kiteline-agent upgrade --archive "$kiteline_upgrade/$kiteline_name" || kiteline_result=$?
else
  sudo -- /usr/local/bin/kiteline-agent upgrade --archive "$kiteline_upgrade/$kiteline_name" || kiteline_result=$?
fi
[ "$kiteline_interrupted" -eq 0 ] || kiteline_result=$kiteline_interrupted
exit "$kiteline_result"
`;
}

export async function serveAgentInstallation(
  path: string,
  directory: string,
  entryOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (
    path !== "/connect.sh" &&
    path !== "/upgrade.sh" &&
    path !== "/install.sh" &&
    path !== "/connect.ps1" &&
    path !== "/upgrade.ps1" &&
    path !== "/install.ps1" &&
    !path.startsWith("/downloads/")
  )
    return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  if (["/connect.sh", "/upgrade.sh", "/connect.ps1", "/upgrade.ps1"].includes(path)) {
    const script =
      path === "/connect.sh"
        ? connectionScript(entryOrigin)
        : path === "/upgrade.sh"
          ? upgradeScript(entryOrigin)
          : windowsScript(entryOrigin, path === "/connect.ps1" ? "Connect" : "Upgrade");
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(script),
      "cache-control": "no-cache",
      "content-disposition": `attachment; filename="${path.slice(1)}"`,
    });
    response.end(request.method === "HEAD" ? undefined : script);
    return true;
  }
  let filename = ["/install.sh", "/install.ps1"].includes(path) ? path.slice(1) : undefined;
  for (const arch of ["amd64", "arm64"])
    for (const suffix of [".tar.gz", ".tar.gz.sha256"]) {
      const name = `kiteline-agent-${appVersion}-linux-${arch}${suffix}`;
      if (path === `/downloads/agent/${appVersion}/${name}`) filename = name;
    }
  for (const suffix of [".zip", ".zip.sha256"]) {
    const name = `kiteline-agent-${appVersion}-windows-amd64${suffix}`;
    if (path === `/downloads/agent/${appVersion}/${name}`) filename = name;
  }
  for (const suffix of [".tar.gz", ".tar.gz.sha256"]) {
    const name = `kiteline-agent-${appVersion}-macos-amd64${suffix}`;
    if (path === `/downloads/agent/${appVersion}/${name}`) filename = name;
  }
  if (!filename) throw new AppError("not_found", "Installation resource not found");
  const file = await open(resolve(directory, filename), "r").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new AppError(
          "not_found",
          "This server does not include the matching installation resources; check the release package",
        );
      throw error;
    },
  );
  try {
    const info = await file.stat();
    response.writeHead(200, {
      "content-type": filename.endsWith(".tar.gz")
        ? "application/gzip"
        : filename.endsWith(".zip")
          ? "application/zip"
          : "text/plain; charset=utf-8",
      "content-length": info.size,
      "cache-control": "no-cache",
      "content-disposition": `attachment; filename="${filename}"`,
    });
    if (request.method === "HEAD") response.end();
    else await pipeline(file.createReadStream({ autoClose: false }), response);
  } finally {
    await file.close();
  }
  return true;
}
