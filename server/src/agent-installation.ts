import type { IncomingMessage, ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, appVersion } from "@kiteline/shared/protocol";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function installationCommands(publicUrl: string, code: string) {
  const origin = quote(publicUrl);
  const bind = `kiteline-agent check && printf '%s\\n' ${quote(code)} | kiteline-agent bind --server ${origin} --if-unbound`;
  const command = (service: boolean) => `(
set -e
for kiteline_tool in curl mktemp; do
  command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; Ubuntu 24.04: sudo apt-get update && sudo apt-get install -y curl ca-certificates coreutils" >&2; exit 1; }
done
kiteline_install=$(mktemp /var/tmp/kiteline-install.XXXXXX)
trap 'rm -f "$kiteline_install"' EXIT
curl -fsSL --proto '=https' --proto-redir '=https' ${quote(publicUrl + "/install.sh")} -o "$kiteline_install"
sh "$kiteline_install" --server ${origin} --version ${quote(appVersion)} --code ${quote(code)}${service ? " --service" : ""}
)`;
  return { foreground: command(false), service: command(true), bind };
}

export function upgradeCommand(publicUrl: string) {
  return {
    version: appVersion,
    command: `(
set -e
for kiteline_tool in curl mktemp uname id; do
  command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; Ubuntu 24.04: sudo apt-get update && sudo apt-get install -y curl ca-certificates coreutils" >&2; exit 1; }
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
kiteline_base=${quote(publicUrl + "/downloads/agent/" + appVersion + "/")}"$kiteline_name"
curl -fsSL --proto '=https' --proto-redir '=https' "$kiteline_base" -o "$kiteline_upgrade/$kiteline_name"
curl -fsSL --proto '=https' --proto-redir '=https' "$kiteline_base.sha256" -o "$kiteline_upgrade/$kiteline_name.sha256"
if [ "$(id -u)" -eq 0 ]; then
  /usr/local/bin/kiteline-agent service upgrade --archive "$kiteline_upgrade/$kiteline_name"
else
  sudo -- /usr/local/bin/kiteline-agent service upgrade --archive "$kiteline_upgrade/$kiteline_name"
fi
)`,
  };
}

export async function serveAgentInstallation(
  path: string,
  directory: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (path !== "/install.sh" && !path.startsWith("/downloads/")) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
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
