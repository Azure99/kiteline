import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  expectedRelease,
  packageNames,
  releaseMatches,
  sourceCommit as readSourceCommit,
} from "./release-artifacts.mjs";
import { run } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(resolve(root, "release/inputs.json"), "utf8"));
const { version } = JSON.parse(readFileSync(resolve(root, "shared/src/version.json"), "utf8"));
const arch = process.argv[2];
if (!Object.hasOwn(release.nodeArchives, arch ?? ""))
  throw new Error("Usage: pnpm images amd64|arm64");
const target = `linux-${arch}`;
const { name, archive } = packageNames("server", version, target);
const sourceCommit = readSourceCommit(root);
const manifest = spawnSync(
  "tar",
  ["-xOf", resolve(root, "dist/releases", archive), `${name}/release.json`],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
if (manifest.error) throw manifest.error;
if (manifest.status !== 0) throw new Error(`Cannot read server ${arch} release manifest`);
if (
  !releaseMatches(
    JSON.parse(manifest.stdout),
    expectedRelease(release, version, "server", target, sourceCommit),
  )
)
  throw new Error(
    `Server ${arch} must match this source/version/platform/architecture; rebuild it`,
  );
const temporary = mkdtempSync("/var/tmp/kiteline-image-");
const imageFile = resolve(temporary, "image-id");
try {
  run(
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
      "--iidfile",
      imageFile,
      "-f",
      "release/Dockerfile.server",
      ".",
    ],
    { cwd: root },
  );
  if (readSourceCommit(root) !== sourceCommit)
    throw new Error("Source changed during the image build; rerun the build");
  run("docker", [
    "tag",
    readFileSync(imageFile, "utf8").trim(),
    `kiteline-server:${version}-${arch}`,
  ]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
