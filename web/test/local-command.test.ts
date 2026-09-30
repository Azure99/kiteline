import { expect, test } from "vitest";
import { localCommand } from "../src/terminal/local-command";
import type { AgentEnvironment } from "@kiteline/shared/protocol";

test("local attach uses the observed launcher and explicit runtime directory", () => {
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
      "'/opt/kiteline'\\''s/bin/kiteline-agent' attach session --run-dir '/var/tmp/run'\\''s'",
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
  expect(windows).toBe(
    "& 'C:\\Kiteline''s\\kiteline-agent.ps1' attach 'session' --run-dir 'C:\\run'",
  );
  expect(
    localCommand(
      { ...environment, cliPath: "/usr/local/bin/kiteline-agent", runDir: "/actual/run" },
      "0123456789abcdef",
    ),
  ).toBe("/usr/local/bin/kiteline-agent attach 0123456789abcdef --run-dir '/actual/run'");
});
