export const unixInstallationLayout = {
  directory: "/opt/kiteline-agent",
  useFile: "/opt/.kiteline-agent-use.lock",
  recordFile: "/etc/kiteline-agent.json",
  environmentFile: "/etc/kiteline-agent.env",
  managementFile: "/opt/.kiteline-agent-install.lock",
  launcherFile: "/usr/local/bin/kiteline-agent",
  managementLockFd: 9,
} as const;

export const windowsInstallationLayout = {
  directoryName: "kiteline-agent",
  recordFile: "installation.json",
} as const;
