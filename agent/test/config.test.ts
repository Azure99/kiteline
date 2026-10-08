import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentConfig, agentPaths } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

test("explicit attach directory wins over inherited directories without reading Shell configuration", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-attach-paths-");
  vi.stubEnv("KITELINE_AGENT_HOME", root);
  vi.stubEnv("KITELINE_AGENT_RUN_DIR", join(root, "other"));
  try {
    await writeFile(join(root, "config.json"), "not JSON");
    expect((await agentPaths(join(root, "actual run"))).runDir).toBe(join(root, "actual run"));
    expect((await agentPaths()).runDir).toBe(join(root, "other"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration bounds timers and task capacity without limiting transfer bytes", async () => {
  const root = await mkdtemp("/var/tmp/kiteline-timer-config-");
  vi.stubEnv("KITELINE_AGENT_HOME", root);
  vi.stubEnv("KITELINE_AGENT_RUN_DIR", join(root, "run"));
  try {
    const configure = (limits: object) =>
      writeFile(join(root, "config.json"), JSON.stringify({ limits }));
    for (const key of ["rpcTimeout", "searchTimeout", "gitWriteTimeout"] as const) {
      const maximum = key === "rpcTimeout" ? 2147482647 : 2147483647;
      await configure({ [key]: maximum });
      expect((await agentConfig()).limits[key]).toBe(maximum);
      await configure({ [key]: maximum + 1 });
      await expect(agentConfig()).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await configure({ transferBytes: 2147483648 });
    expect((await agentConfig()).limits.transferBytes).toBe(2147483648);
    await configure({ tasksPerDevice: 300 });
    expect((await agentConfig()).limits.tasksPerDevice).toBe(300);
    await configure({ tasksPerDevice: 301 });
    await expect(agentConfig()).rejects.toMatchObject({ code: "invalid_argument" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
