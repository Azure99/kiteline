import type { IncomingMessage, ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError, appVersion } from "@kiteline/shared/protocol";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function installationCommands(publicUrl: string, code: string) {
  const origin = quote(publicUrl);
  const bind = `kiteline-agent check --service && printf '%s\\n' ${quote(code)} | kiteline-agent bind --server ${origin} --if-unbound`;
  const command = (service: boolean) => `(
set -e
for kiteline_tool in curl mktemp; do
  command -v "$kiteline_tool" >/dev/null || { echo "缺少 $kiteline_tool；Ubuntu 24.04: sudo apt-get update && sudo apt-get install -y curl ca-certificates coreutils" >&2; exit 1; }
done
kiteline_install=$(mktemp /var/tmp/kiteline-install.XXXXXX)
trap 'rm -f "$kiteline_install"' EXIT
curl -fsSL --proto '=https' --proto-redir '=https' ${quote(publicUrl + "/install.sh")} -o "$kiteline_install"
sh "$kiteline_install" --server ${origin} --version ${quote(appVersion)} --code ${quote(code)}${service ? " --service" : ""}
)`;
  return { foreground: command(false), service: command(true), bind };
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
  if (!filename) throw new AppError("not_found", "安装资源不存在");
  const file = await open(resolve(directory, filename), "r").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new AppError("not_found", "此 server 未包含配套安装资源，请检查发布包");
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
