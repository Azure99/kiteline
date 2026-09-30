import { expect, test } from "vitest";
import { localCommand } from "../src/terminal/local-command";
import type { AgentEnvironment } from "@kiteline/shared/protocol";

test("local attach uses the observed launcher and both instance paths", () => {
  const environment: AgentEnvironment = {
    os: "linux",
    homePath: "/home/project",
    rootPaths: ["/"],
    cliPath: "/opt/kiteline's/bin/kiteline-agent",
    dataDir: "/var/tmp/data one",
    runDir: "/var/tmp/run's",
  };
  for (const os of ["linux", "macos"] as const)
    expect(localCommand({ ...environment, os }, "session")).toBe(
      "KITELINE_AGENT_HOME='/var/tmp/data one' KITELINE_AGENT_RUN_DIR='/var/tmp/run'\\''s' '/opt/kiteline'\\''s/bin/kiteline-agent' terminal attach 'session'",
    );
  const windows = localCommand(
    {
      ...environment,
      os: "windows",
      cliPath: "C:\\Kiteline's\\kiteline-agent.ps1",
      dataDir: "C:\\data",
      runDir: "C:\\run",
    },
    "session",
  );
  expect(windows).toContain("& 'C:\\Kiteline''s\\kiteline-agent.ps1' terminal attach 'session'");
  expect(windows).toContain(
    "$env:KITELINE_AGENT_HOME = 'C:\\data'; $env:KITELINE_AGENT_RUN_DIR = 'C:\\run'",
  );
  expect(windows).toContain(
    "if ($null -eq $kitelineHome) { Remove-Item Env:KITELINE_AGENT_HOME -ErrorAction SilentlyContinue } else { $env:KITELINE_AGENT_HOME = $kitelineHome }",
  );
  expect(windows).toContain(
    "if ($null -eq $kitelineRun) { Remove-Item Env:KITELINE_AGENT_RUN_DIR -ErrorAction SilentlyContinue } else { $env:KITELINE_AGENT_RUN_DIR = $kitelineRun }",
  );
});
