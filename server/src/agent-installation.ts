import type { IncomingMessage, ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, appVersion } from "@kiteline/shared/protocol";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function curlCommand(entryOrigin: string) {
  const protocols = entryOrigin.startsWith("https:") ? "=https" : "=http,https";
  return `curl -fsSL --proto '${protocols}' --proto-redir '${protocols}'`;
}

export function installationCommands(entryOrigin: string, code: string) {
  const origin = quote(entryOrigin);
  const bind = `kiteline-agent check && printf '%s\\n' ${quote(code)} | kiteline-agent bind --server ${origin} --if-unbound`;
  const command = (service: boolean) =>
    `${curlCommand(entryOrigin)} ${quote(entryOrigin + "/connect.sh")} | sh -s -- ${quote(code)}${service ? " --service" : ""}`;
  return { foreground: command(false), service: command(true), bind };
}

function connectionScript(entryOrigin: string) {
  return `#!/bin/sh
set -eu

connect() {
    if [ "$#" -ne 1 ] && ! { [ "$#" -eq 2 ] && [ "$2" = --service ]; }; then
        echo 'Usage: sh -s -- CODE [--service]' >&2
        exit 1
    fi
    [ -n "$1" ] || { echo 'Missing binding code; generate a connection command in the web app' >&2; exit 1; }
    for kiteline_tool in curl mktemp; do
        command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; install curl, CA certificates and core utilities using your system package manager, then run this command again" >&2; exit 1; }
    done
    kiteline_install=$(mktemp /var/tmp/kiteline-install.XXXXXX)
    trap 'rm -f "$kiteline_install"' EXIT
    ${curlCommand(entryOrigin)} ${quote(entryOrigin + "/install.sh")} -o "$kiteline_install"
    kiteline_code=$1
    shift
    sh "$kiteline_install" --server ${quote(entryOrigin)} --version ${quote(appVersion)} --code "$kiteline_code" "$@"
}

connect "$@"
`;
}

export function upgradeCommand(entryOrigin: string) {
  return {
    version: appVersion,
    command: `(kiteline_script=$(${curlCommand(entryOrigin)} ${quote(entryOrigin + "/upgrade.sh")}) && sh -c "$kiteline_script" -- --version ${quote(appVersion)})`,
  };
}

function upgradeScript(entryOrigin: string) {
  return `#!/bin/sh
set -eu
[ "$#" -eq 2 ] && [ "$1" = --version ] && [ "$2" = ${quote(appVersion)} ] || { echo 'The server release changed; obtain a new upgrade command from the web app' >&2; exit 1; }
[ -t 0 ] || { echo 'Run this command in an interactive terminal or SSH session on the target device' >&2; exit 1; }
for kiteline_tool in curl mktemp uname id; do
  command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; install curl, CA certificates and core utilities using your system package manager, then run this command again" >&2; exit 1; }
done
[ "$(uname -s)" = Linux ] || { echo 'Only Linux is supported' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) kiteline_arch=amd64 ;;
  aarch64|arm64) kiteline_arch=arm64 ;;
  *) echo 'Only Linux amd64/arm64 is supported' >&2; exit 1 ;;
esac
[ -x /usr/local/bin/kiteline-agent ] || { echo 'Install and bind the agent before upgrading' >&2; exit 1; }
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo 'The upgrade requires sudo or root' >&2; exit 1; }
fi
kiteline_upgrade=$(mktemp -d /var/tmp/kiteline-agent-upgrade.XXXXXX)
trap 'rm -rf "$kiteline_upgrade"' EXIT
kiteline_name="kiteline-agent-${appVersion}-linux-$kiteline_arch.tar.gz"
kiteline_base=${quote(entryOrigin + "/downloads/agent/" + appVersion + "/")}"$kiteline_name"
${curlCommand(entryOrigin)} "$kiteline_base" -o "$kiteline_upgrade/$kiteline_name"
${curlCommand(entryOrigin)} "$kiteline_base.sha256" -o "$kiteline_upgrade/$kiteline_name.sha256"
if [ "$(id -u)" -eq 0 ]; then
  /usr/local/bin/kiteline-agent service upgrade --archive "$kiteline_upgrade/$kiteline_name"
else
  sudo -- /usr/local/bin/kiteline-agent service upgrade --archive "$kiteline_upgrade/$kiteline_name"
fi
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
    !path.startsWith("/downloads/")
  )
    return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  if (path === "/connect.sh" || path === "/upgrade.sh") {
    const script =
      path === "/connect.sh" ? connectionScript(entryOrigin) : upgradeScript(entryOrigin);
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(script),
      "cache-control": "no-cache",
      "content-disposition": `attachment; filename="${path.slice(1)}"`,
    });
    response.end(request.method === "HEAD" ? undefined : script);
    return true;
  }
  let filename = path === "/install.sh" ? "install.sh" : undefined;
  for (const arch of ["amd64", "arm64"])
    for (const suffix of [".tar.gz", ".tar.gz.sha256"]) {
      const name = `kiteline-agent-${appVersion}-linux-${arch}${suffix}`;
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
