import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { agentTargets, packageNames, sourceCommit } from "./release-artifacts.mjs";
import { digest, run } from "./release-inputs.mjs";

const [mode, extra] = process.argv.slice(2);
if (extra || !["plan", "candidate", "dev-image", "publish"].includes(mode))
  throw new Error("Usage: node scripts/ci-release.mjs plan|candidate|dev-image|publish");
const root = process.cwd();
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const capture = (file, args) =>
  run(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const tag = process.env.CI_TAG ?? "";
const product = mode === "publish" ? process.env.CI_SOURCE : sourceCommit(root);
const version = mode === "publish" ? tag.slice(1) : json("shared/src/version.json").version;
const repository = process.env.GITHUB_REPOSITORY;
const registry = `ghcr.io/${repository?.toLowerCase()}`;

function tagSource() {
  assert.match(tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/, "Tag must use vX.Y.Z");
  const sha = capture("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  const tagged = JSON.parse(capture("git", ["show", `${sha}:shared/src/version.json`]));
  assert.equal(tag, `v${tagged.version}`, "Tag must match the product version");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    stdio: "inherit",
  });
  if (ancestor.error) throw ancestor.error;
  assert.equal(ancestor.status, 0, "Tagged commit must belong to main history");
  return sha;
}

function plan() {
  const requested = process.env.CI_MODE;
  assert.ok(
    ["checks", "full", "candidate", "dev-image", "publish"].includes(requested),
    `Unknown CI operation: ${requested}`,
  );
  if (["dev-image", "publish"].includes(requested))
    assert.equal(process.env.GITHUB_REF, "refs/heads/main", `${requested} requires main`);
  const tagged = ["candidate", "publish"].includes(requested);
  const sha = tagged ? tagSource() : product;
  console.log(`source=${sha}\nmode=${requested}\ntag=${tagged ? tag : ""}`);
}

function api(method, path, body) {
  const args = ["api", "--method", method, `repos/${repository}/${path}`];
  if (body !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GitHub ${method} ${path}: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}
function findRelease() {
  const pages = JSON.parse(
    capture("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
  );
  return pages.flat().find((release) => release.tag_name === tag);
}
function remoteImage(reference, allowMissing = false) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (
    allowMissing &&
    result.status === 1 &&
    result.stderr.trim() === `ERROR: ${reference}: not found`
  )
    return undefined;
  if (result.status !== 0)
    throw new Error(`Cannot inspect image ${reference}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}
function platforms(index) {
  assert.equal(index.manifests?.length, 2, "Expected a two-platform image index");
  const result = {};
  for (const entry of index.manifests) {
    assert.equal(entry.platform.os, "linux", "Image index must contain Linux images");
    const arch = entry.platform.architecture;
    assert.ok(["amd64", "arm64"].includes(arch), `Unexpected image architecture: ${arch}`);
    assert.equal(result[arch], undefined, `Duplicate image architecture: ${arch}`);
    result[arch] = entry.digest;
  }
  return result;
}

function packageFiles(directory) {
  return [
    ...agentTargets.map((target) => ["agent", target]),
    ["server", "linux-amd64"],
    ["server", "linux-arm64"],
  ].map(([kind, target]) => join(directory, packageNames(kind, version, target).archive));
}
function checksum(file) {
  return `${digest(file)}  ${basename(file)}\n`;
}
function loadImages() {
  const images = {};
  for (const arch of ["amd64", "arm64"]) {
    run("docker", [
      "load",
      "--input",
      join(root, "dist/releases", `kiteline-server-${version}-${arch}.tar`),
    ]);
    const local = `kiteline-server:${version}-${arch}`;
    images[arch] = JSON.parse(capture("docker", ["image", "inspect", local]))[0].Id;
  }
  return images;
}
function pushImages(images, suffix) {
  const digests = {};
  for (const [arch, id] of Object.entries(images)) {
    const reference = `${registry}:${suffix}-${arch}`;
    run("docker", ["tag", id, reference]);
    run("docker", ["push", reference]);
    digests[arch] = remoteImage(reference).digest;
  }
  const reference = `${registry}:${suffix}`;
  run("docker", [
    "buildx",
    "imagetools",
    "create",
    "--tag",
    reference,
    ...Object.values(digests).map((value) => `${registry}@${value}`),
  ]);
  const index = remoteImage(reference);
  assert.deepEqual(platforms(index), digests, "Image index differs from the pushed architectures");
  console.log(`Built image: ${registry}@${index.digest}`);
  return index.digest;
}
function copyIndex(imageDigest, reference) {
  run("docker", [
    "buildx",
    "imagetools",
    "create",
    "--tag",
    reference,
    `${registry}@${imageDigest}`,
  ]);
  assert.equal(
    remoteImage(reference).digest,
    imageDigest,
    "Image promotion changed the index digest",
  );
  console.log(`Image available: ${reference}@${imageDigest}`);
}

function candidate(temporary) {
  let release = findRelease();
  assert.ok(!release || release.draft, `Release ${tag} is already published; cannot rebuild it`);
  const packages = packageFiles(join(root, "dist/releases"));
  const sums = join(temporary, "SHA256SUMS");
  writeFileSync(sums, packages.map(checksum).sort().join(""));
  const images = loadImages();
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  const body = { draft: true, body: `Source: ${product}\n\nBuild: ${runUrl}\n` };
  if (release) release = api("PATCH", `releases/${release.id}`, body);
  else
    release = api("POST", "releases", {
      ...body,
      tag_name: tag,
      target_commitish: product,
      name: tag,
    });
  const previous = release.assets.find((asset) => asset.name === "delivery.json");
  if (previous) api("DELETE", `releases/assets/${previous.id}`);
  run("gh", [
    "release",
    "upload",
    tag,
    "--repo",
    repository,
    "--clobber",
    ...packages.flatMap((file) => [file, file + ".sha256"]),
    sums,
  ]);
  const imageDigest = pushImages(images, `candidate-${tag}-${runId}`);
  const delivery = join(temporary, "delivery.json");
  writeFileSync(
    delivery,
    JSON.stringify(
      { sourceCommit: product, runId, checksumsSha256: digest(sums), imageDigest },
      null,
      2,
    ) + "\n",
  );
  run("gh", ["release", "upload", tag, delivery, "--repo", repository, "--clobber"]);
  console.log(`Candidate complete: ${release.html_url}`);
}

function devImage() {
  const imageDigest = pushImages(loadImages(), `dev-${product}`);
  assert.equal(
    api("GET", "git/ref/heads/main").object.sha,
    product,
    "main advanced; the dev-commit image is available, but updating dev requires a new run",
  );
  copyIndex(imageDigest, `${registry}:dev`);
}

function publish(temporary) {
  const release = findRelease();
  assert.ok(release, `Release ${tag} does not exist; build a candidate first`);
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repository,
    "--pattern",
    "delivery.json",
    "--pattern",
    "kiteline-*",
    "--pattern",
    "SHA256SUMS",
    "--dir",
    temporary,
  ]);
  const delivery = json(join(temporary, "delivery.json"));
  assert.equal(delivery.sourceCommit, product, "Candidate source differs from the selected tag");
  const packages = packageFiles(temporary);
  const actualChecksums = packages.map((file) => {
    const expected = checksum(file);
    assert.equal(
      readFileSync(file + ".sha256", "utf8"),
      expected,
      `Package checksum differs: ${basename(file)}`,
    );
    return expected;
  });
  const sums = join(temporary, "SHA256SUMS");
  assert.equal(
    readFileSync(sums, "utf8"),
    actualChecksums.sort().join(""),
    "Release SHA256SUMS differs from the downloaded packages",
  );
  assert.equal(
    digest(sums),
    delivery.checksumsSha256,
    "Release checksums differ from the candidate",
  );
  const reference = `${registry}:${version}`;
  const published = remoteImage(reference, true);
  if (published)
    assert.equal(
      published.digest,
      delivery.imageDigest,
      `Version image ${reference} already differs`,
    );
  else copyIndex(delivery.imageDigest, reference);
  if (release.draft) api("PATCH", `releases/${release.id}`, { draft: false });
  console.log(`Published existing candidate: ${release.html_url}`);
}

if (mode === "plan") plan();
else {
  const temporary = mkdtempSync("/var/tmp/kiteline-distribution-");
  try {
    if (mode === "candidate") candidate(temporary);
    else if (mode === "dev-image") devImage();
    else publish(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
