import { agentTargets, packageNames } from "@kiteline/shared/artifacts";
import { powershellQuote, shellQuote } from "@kiteline/shared/template";

export const cliTargets = agentTargets;
export type CliTarget = (typeof cliTargets)[number];
export type CliShell = "unix" | "powershell";

function cliEntry(shell: CliShell) {
  return shell === "powershell" ? "kiteline.ps1" : "kiteline";
}

function quoteArgument(value: string, shell: CliShell) {
  return (shell === "powershell" ? powershellQuote : shellQuote)(value);
}

export function loginCommand(origin: string, shell: CliShell) {
  return `${cliEntry(shell)} auth login --server ${quoteArgument(origin, shell)}`;
}

export function attachCommand(
  deviceId: string,
  workspaceId: string,
  sessionId: string,
  shell: CliShell,
) {
  return `${cliEntry(shell)} terminal attach --device ${quoteArgument(deviceId, shell)} --workspace ${quoteArgument(workspaceId, shell)} --session ${quoteArgument(sessionId, shell)}`;
}

export function cliDownload(version: string, target: CliTarget) {
  const { archive } = packageNames("cli", version, target);
  return `https://github.com/Azure99/kiteline/releases/download/v${version}/${archive}`;
}

export function cliGuide(version: string, target: CliTarget, language: string) {
  const chinese = language.startsWith("zh");
  const section =
    target === "windows-amd64" ? "windows" : chinese ? "linux-和-macos" : "linux-and-macos";
  return `https://github.com/Azure99/kiteline/blob/v${version}/docs/guide/cli${chinese ? "" : ".en"}.md#${section}`;
}
