import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  candidateCompose,
  packageNames,
  serverImageArchive,
  serverImageName,
} from "./release-artifacts.mjs";

test.each([
  ["agent", "linux-amd64", "kiteline-agent-1.2.3-linux-amd64.tar.gz"],
  ["agent", "windows-amd64", "kiteline-agent-1.2.3-windows-amd64.zip"],
  ["agent", "macos-amd64", "kiteline-agent-1.2.3-macos-amd64.tar.gz"],
  ["cli", "linux-arm64", "kiteline-cli-1.2.3-linux-arm64.tar.gz"],
  ["cli", "windows-amd64", "kiteline-cli-1.2.3-windows-amd64.zip"],
  ["server", "linux-arm64", "kiteline-server-1.2.3-linux-arm64.tar.gz"],
])("%s %s retains its release name and archive", (kind, target, archive) => {
  expect(packageNames(kind, "1.2.3", target)).toEqual({
    name: archive.replace(/\.(?:zip|tar\.gz)$/, ""),
    archive,
  });
});

test.each([
  ["amd64", "kiteline-server:1.2.3-amd64", "kiteline-server-1.2.3-amd64.tar"],
  ["arm64", "kiteline-server:1.2.3-arm64", "kiteline-server-1.2.3-arm64.tar"],
])("server %s retains its local image and export names", (architecture, image, archive) => {
  expect(serverImageName("1.2.3", architecture)).toBe(image);
  expect(serverImageArchive("1.2.3", architecture)).toBe(archive);
});

test("candidate Compose preserves the deployment template and defaults to the release version", () => {
  const template = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8");
  expect(candidateCompose(template, "1.2.3")).toBe(
    template.replace(
      "${KITELINE_VERSION:?Set KITELINE_VERSION to the release version}",
      "${KITELINE_VERSION:-1.2.3}",
    ),
  );
});
