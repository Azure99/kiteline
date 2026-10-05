import { join } from "node:path";
import { defaultAgentLimits, type AgentConfig } from "../../src/config.js";

export function testConfig(
  dataDir: string,
  overrides: Omit<Partial<AgentConfig>, "limits"> & {
    limits?: Partial<AgentConfig["limits"]>;
  } = {},
): AgentConfig {
  return {
    dataDir,
    runDir: join(dataDir, "run"),
    shell: "/bin/sh",
    ...overrides,
    limits: { ...defaultAgentLimits, ...overrides.limits },
  };
}
