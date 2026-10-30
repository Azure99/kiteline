import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { agentTargets, packageNames } from "@kiteline/shared/artifacts";
import { resourceDirectory } from "@kiteline/shared/node/paths";
import { powershellQuote, renderValues, shellQuote } from "@kiteline/shared/template";
import { AppError, appVersion } from "@kiteline/shared/protocol";
import { closeIfBodyUnread } from "./http.js";

const connectionTemplate = readFileSync(
  resolve(resourceDirectory, "installer/connect.in.sh"),
  "utf8",
);
const upgradeTemplate = readFileSync(resolve(resourceDirectory, "installer/upgrade.in.sh"), "utf8");
const windowsTemplate = readFileSync(
  resolve(resourceDirectory, "installer/windows-entry.in.ps1"),
  "utf8",
);
const agentDownloads = new Map<string, string>(
  agentTargets.flatMap((target) => {
    const { archive } = packageNames("agent", appVersion, target);
    return [archive, `${archive}.sha256`].map(
      (filename) => [`/downloads/agent/${appVersion}/${filename}`, filename] as const,
    );
  }),
);
const windowsLauncher =
  "(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'kiteline-agent/kiteline-agent.ps1')";
const windowsShell =
  "(Join-Path $PSHOME $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'powershell.exe' } else { 'pwsh.exe' }))";
function powershellCommand(url: string, arguments_: string) {
  return `& ([scriptblock]::Create((irm ${powershellQuote(url)} -ErrorAction Stop))) ${arguments_}`;
}
function curlCommand(entryOrigin: string) {
  const protocols = entryOrigin.startsWith("https:") ? "=https" : "=http,https";
  return `curl -fsSL --proto '${protocols}' --proto-redir '${protocols}'`;
}

export function installationCommands(entryOrigin: string, code: string) {
  const origin = shellQuote(entryOrigin);
  const bind = `kiteline-agent check && printf '%s\\n' ${shellQuote(code)} | kiteline-agent bind --server ${origin} --if-unbound`;
  const install = (platform: "linux" | "macos") =>
    `(kiteline_script=$(${curlCommand(entryOrigin)} ${shellQuote(entryOrigin + "/connect.sh")}) && sh -c "$kiteline_script" -- ${platform} ${shellQuote(code)})`;
  return {
    linux: { install: install("linux"), bind },
    macos: { install: install("macos"), bind },
    windows: {
      install: powershellCommand(
        entryOrigin + "/connect.ps1",
        `-Version ${powershellQuote(appVersion)} -Code ${powershellQuote(code)}`,
      ),
      bind: `& ${windowsShell} -NoProfile -ExecutionPolicy Bypass -File ${windowsLauncher} check; if ($LASTEXITCODE -eq 0) { ${powershellQuote(code)} | & ${windowsShell} -NoProfile -ExecutionPolicy Bypass -File ${windowsLauncher} bind --server ${powershellQuote(entryOrigin)} --if-unbound }`,
    },
  };
}

function connectionScript(entryOrigin: string) {
  const values: Record<string, string> = {
    __KITELINE_CURL__: curlCommand(entryOrigin),
    __KITELINE_INSTALL_URL__: shellQuote(entryOrigin + "/install.sh"),
    __KITELINE_ORIGIN__: shellQuote(entryOrigin),
    __KITELINE_VERSION__: shellQuote(appVersion),
  };
  return renderValues(connectionTemplate, values);
}

export function upgradeCommand(entryOrigin: string) {
  const unix = (platform: "linux" | "macos") =>
    `(kiteline_script=$(${curlCommand(entryOrigin)} ${shellQuote(entryOrigin + "/upgrade.sh")}) && sh -c "$kiteline_script" -- --version ${shellQuote(appVersion)} --platform ${platform})`;
  return {
    version: appVersion,
    commands: {
      linux: unix("linux"),
      macos: unix("macos"),
      windows: powershellCommand(
        entryOrigin + "/upgrade.ps1",
        `-Version ${powershellQuote(appVersion)}`,
      ),
    },
  };
}

function windowsScript(entryOrigin: string, mode: "Connect" | "Upgrade") {
  const values: Record<string, string> = {
    __KITELINE_VERSION__: powershellQuote(appVersion),
    __KITELINE_INSTALL_URL__: powershellQuote(entryOrigin + "/install.ps1"),
    __KITELINE_MODE__: mode,
    __KITELINE_ORIGIN__: powershellQuote(entryOrigin),
  };
  return renderValues(windowsTemplate, values);
}

function upgradeScript(entryOrigin: string) {
  const values: Record<string, string> = {
    __KITELINE_VERSION__: shellQuote(appVersion),
    __KITELINE_ARCHIVE_VERSION__: appVersion,
    __KITELINE_DOWNLOAD_URL__: shellQuote(entryOrigin + "/downloads/agent/" + appVersion + "/"),
    __KITELINE_CURL__: curlCommand(entryOrigin),
  };
  return renderValues(upgradeTemplate, values);
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
    closeIfBodyUnread(response);
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
    closeIfBodyUnread(response);
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(script),
      "cache-control": "no-cache",
      "content-disposition": `attachment; filename="${path.slice(1)}"`,
    });
    response.end(request.method === "HEAD" ? undefined : script);
    return true;
  }
  const filename = ["/install.sh", "/install.ps1"].includes(path)
    ? path.slice(1)
    : agentDownloads.get(path);
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
    closeIfBodyUnread(response);
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
