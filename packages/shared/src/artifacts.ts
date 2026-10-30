export const agentTargets = [
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "macos-amd64",
  "macos-arm64",
] as const;

export const serverArchitectures = ["amd64", "arm64"];

export function packageNames(kind: string, version: string, target: string) {
  const name = `kiteline-${kind}-${version}-${target}`;
  return { name, archive: `${name}.${target.startsWith("windows-") ? "zip" : "tar.gz"}` };
}
