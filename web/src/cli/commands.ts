export const cliTargets = [
  "linux-amd64",
  "linux-arm64",
  "macos-amd64",
  "macos-arm64",
  "windows-amd64",
] as const;
export type CliTarget = (typeof cliTargets)[number];
export type CliShell = "unix" | "powershell";

export function cliEntry(shell: CliShell) {
  return shell === "powershell" ? "kiteline.ps1" : "kiteline";
}

export function quoteArgument(value: string, shell: CliShell) {
  return `'${value.replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
}

export function loginCommand(origin: string, shell: CliShell) {
  return `${cliEntry(shell)} auth login --server ${quoteArgument(origin, shell)}`;
}

export function cliDownload(version: string, target: CliTarget) {
  const extension = target === "windows-amd64" ? "zip" : "tar.gz";
  return `https://github.com/Azure99/kiteline/releases/download/v${version}/kiteline-cli-${version}-${target}.${extension}`;
}

export function cliGuide(version: string, target: CliTarget, language: string) {
  const chinese = language.startsWith("zh");
  const section =
    target === "windows-amd64" ? "windows" : chinese ? "linux-和-macos" : "linux-and-macos";
  return `https://github.com/Azure99/kiteline/blob/v${version}/docs/guide/cli${chinese ? "" : ".en"}.md#${section}`;
}
