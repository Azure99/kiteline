import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { powershellQuote, renderValues, shellQuote } from "../packages/shared/src/template.ts";

const template = readFileSync(
  new URL("../installer/kiteline-agent.in.sh", import.meta.url),
  "utf8",
);
export function windowsCliLauncher(terminalReset: Buffer) {
  return renderValues(readFileSync(new URL("../installer/kiteline.ps1", import.meta.url), "utf8"), {
    __TERMINAL_RESET_BASE64__: terminalReset.toString("base64"),
  });
}

export function agentLauncher(
  source: string | undefined,
  paths: { directory: string; management: string; managementFd: number; use: string },
  platform: NodeJS.Platform,
) {
  return renderValues(template, {
    __KITELINE_MODE__: shellQuote(source ? "installed" : "portable"),
    __KITELINE_SOURCE__: shellQuote(source ?? ""),
    __KITELINE_PLATFORM__: shellQuote(platform),
    __KITELINE_INSTALLED__: shellQuote(paths.directory),
    __KITELINE_MANAGEMENT__: shellQuote(paths.management),
    __KITELINE_MANAGEMENT_FD__: String(paths.managementFd),
    __KITELINE_USE__: shellQuote(paths.use),
  });
}

export function windowsAgentLaunchers({
  runtimeFiles,
  nodeEnvironmentKeys,
  layout,
}: {
  runtimeFiles: readonly string[];
  nodeEnvironmentKeys: readonly string[];
  layout: { directoryName: string; recordFile: string };
}) {
  const nativeTemplate = readFileSync(new URL("../installer/launcher.in.cs", import.meta.url));
  const type = `KitelineLauncher_${createHash("sha256").update(nativeTemplate).digest("hex").slice(0, 16)}`;
  const nativeSource = renderValues(nativeTemplate.toString("utf8"), {
    __KITELINE_LAUNCHER_TYPE__: type,
  });
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
  const list = (values: readonly string[]) => "@(" + values.map(powershellQuote).join(",") + ")";
  const template = readFileSync(
    new URL("../installer/kiteline-agent.in.ps1", import.meta.url),
    "utf8",
  );
  const render = (mode: "portable" | "installed") =>
    renderValues(template, {
      __KITELINE_MODE__: powershellQuote(mode),
      __KITELINE_DIRECTORY_NAME__: powershellQuote(layout.directoryName),
      __KITELINE_RECORD_FILE__: powershellQuote(layout.recordFile),
      __KITELINE_REQUIRED_FILES__: list(required),
      __KITELINE_NODE_ENVIRONMENT_KEYS__: list(nodeEnvironmentKeys),
      __KITELINE_NATIVE_SOURCE__: nativeSource,
      __KITELINE_LAUNCHER_TYPE__: type,
    });
  return {
    portable: render("portable"),
    installed: render("installed"),
  };
}
