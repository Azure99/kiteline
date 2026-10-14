import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { cliDownload, cliGuide, loginCommand } from "../src/cli/commands";

test.each([
  ["linux-amd64", "tar.gz"],
  ["linux-arm64", "tar.gz"],
  ["macos-amd64", "tar.gz"],
  ["macos-arm64", "tar.gz"],
  ["windows-amd64", "zip"],
] as const)("downloads the matching %s standalone release", (target, extension) => {
  expect(cliDownload("1.2.3", target)).toBe(
    `https://github.com/Azure99/kiteline/releases/download/v1.2.3/kiteline-cli-1.2.3-${target}.${extension}`,
  );
});

test("installation links use the selected platform and guide language", () => {
  expect(cliGuide("1.2.3", "macos-arm64", "zh-CN")).toBe(
    "https://github.com/Azure99/kiteline/blob/v1.2.3/docs/guide/cli.md#linux-和-macos",
  );
  expect(cliGuide("1.2.3", "windows-amd64", "en")).toBe(
    "https://github.com/Azure99/kiteline/blob/v1.2.3/docs/guide/cli.en.md#windows",
  );
});

test("PowerShell login uses the script entry", () => {
  const origin = "https://desk.example:8443";
  expect(loginCommand(origin, "powershell")).toBe(
    "kiteline.ps1 auth login --server 'https://desk.example:8443'",
  );
});

test.skipIf(process.platform === "win32")("Unix login preserves the server origin", () => {
  const origin = "https://desk.example:8443";
  const output = execFileSync(
    "/bin/sh",
    ["-c", `kiteline() { printf '%s\\n' "$@"; }; ${loginCommand(origin, "unix")}`],
    { encoding: "utf8" },
  );
  expect(output.split("\n")).toEqual(["auth", "login", "--server", origin, ""]);
});
