import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { releaseMatches, sourceDigest } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(resolve(root, "deploy/release.json"), "utf8"));
const { version } = JSON.parse(readFileSync(resolve(root, "shared/src/version.json"), "utf8"));
const arch = process.argv[2];
if (!Object.hasOwn(release.nodeArchives, arch ?? ""))
  throw new Error("Usage: pnpm images amd64|arm64");
const name = `kiteline-server-${version}-linux-${arch}`;
const manifest = spawnSync(
  "tar",
  ["-xOf", resolve(root, "dist/releases", `${name}.tar.gz`), `${name}/release.json`],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
if (manifest.error) throw manifest.error;
if (manifest.status !== 0) throw new Error(`Cannot read server ${arch} release manifest`);
if (
  !releaseMatches(JSON.parse(manifest.stdout), {
    kind: "server",
    platform: "linux",
    version,
    architecture: release.nodeArchives[arch].architecture,
    node: release.node,
    sourceDigest: sourceDigest(root),
  })
)
  throw new Error(
    `Server ${arch} must match this source/version/platform/architecture; rebuild it`,
  );
const result = spawnSync(
  "docker",
  [
    "build",
    "--platform",
    `linux/${arch}`,
    "--target",
    "server",
    "--build-arg",
    `UBUNTU=${release.ubuntu}`,
    "--build-arg",
    `CA_CERTIFICATES_URL=${release.caCertificates.url}`,
    "--build-arg",
    `CA_CERTIFICATES_SHA256=${release.caCertificates.sha256}`,
    "--build-arg",
    `VERSION=${version}`,
    "--build-arg",
    `TARGETARCH=${arch}`,
    "--build-arg",
    "HTTP_PROXY",
    "--build-arg",
    "HTTPS_PROXY",
    "--build-arg",
    "NO_PROXY",
    "-t",
    `kiteline-server:${version}-${arch}`,
    "-f",
    "deploy/Dockerfile",
    ".",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Server image build exited with ${result.status}`);
