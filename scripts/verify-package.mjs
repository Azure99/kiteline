import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  agentTargets,
  digest,
  expectedRelease,
  packageNames,
  releaseMatches,
  sourceCommit,
} from "./release-inputs.mjs";

const [kind, target, archivePath, directoryPath, extra] = process.argv.slice(2);
if (!archivePath || !directoryPath || extra || !["agent", "server"].includes(kind))
  throw new Error(
    "Usage: node scripts/verify-package.mjs agent|server PLATFORM-ARCH ARCHIVE DIRECTORY",
  );
const source = process.cwd();
const archive = resolve(archivePath);
const directory = realpathSync(directoryPath);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const inputs = json(join(source, "release/inputs.json"));
const { version } = json(join(source, "shared/src/version.json"));
const [platform, arch] = target.split("-");
assert.ok(["linux", "macos", "windows"].includes(platform) && inputs.nodeArchives[arch]);
assert.ok(kind === "agent" || platform === "linux");
const { name, archive: filename } = packageNames(kind, version, target);
assert.equal(basename(directory), name);
assert.equal(basename(archive), filename);
const archiveSha = digest(archive);
assert.equal(readFileSync(archive + ".sha256", "utf8"), `${archiveSha}  ${basename(archive)}\n`);
const release = json(join(directory, "release.json"));
assert.ok(
  releaseMatches(release, expectedRelease(inputs, version, kind, target, sourceCommit(source))),
  "Package does not match this checkout, version or target",
);
assert.equal(release.lockfile, digest(join(source, "pnpm-lock.yaml")));

function checksumEntries(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      assert.ok(match, `Invalid checksum line: ${line}`);
      return [match[2], match[1]];
    });
}
const listed = checksumEntries(readFileSync(join(directory, "SHA256SUMS"), "utf8"));
const expected = new Map(listed);
assert.equal(expected.size, listed.length, "Duplicate checksum entry");
const actual = new Map();
let links = 0;
function walk(relative = "") {
  for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
    const key = relative + entry.name;
    const file = join(directory, key);
    if (entry.isDirectory()) walk(key + "/");
    else if (entry.isFile()) {
      if (key !== "SHA256SUMS") actual.set(key, digest(file));
      if (platform !== "windows" && /^(bin|runtime\/bin|dist\/native\/bin)\//.test(key))
        assert.ok(statSync(file).mode & 0o111, `Missing executable permission: ${key}`);
    } else if (entry.isSymbolicLink()) {
      assert.notEqual(platform, "windows", `Windows package contains a link: ${key}`);
      assert.ok(realpathSync(file).startsWith(directory + sep), `Link escapes package: ${key}`);
      links++;
    } else throw new Error(`Unexpected package entry: ${key}`);
  }
}
walk();
assert.deepEqual(actual, expected, "Package file set or checksums differ");
const same = (packaged, original) => assert.equal(actual.get(packaged), digest(original), packaged);
same("LICENSE", join(source, "LICENSE"));
assert.ok(readFileSync(join(directory, "runtime/LICENSE"), "utf8").trim());

const node = readFileSync(
  join(directory, "runtime/bin", platform === "windows" ? "node.exe" : "node"),
);
if (platform === "linux") {
  assert.equal(node.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(node.readUInt16LE(18), arch === "amd64" ? 62 : 183);
} else if (platform === "windows") {
  assert.equal(node.subarray(0, 2).toString(), "MZ");
  assert.equal(node.readUInt16LE(node.readUInt32LE(0x3c) + 4), 0x8664);
}

if (kind === "agent") {
  const identity = json(join(directory, "dist/native/identity.json"));
  assert.equal(identity.node, `v${inputs.node}`);
  assert.equal(identity.architecture, inputs.nodeArchives[arch].architecture);
  assert.equal(identity.tmux, inputs.tmux.version);
  assert.equal(identity.ripgrep.version, inputs.ripgrep.version);
  const rg = `dist/native/bin/rg${platform === "windows" ? ".exe" : ""}`;
  if (platform !== "windows") assert.equal(actual.get(rg), identity.ripgrep.binarySha256, rg);
  if (platform === "linux") {
    assert.equal(identity.linkage, "static-musl");
    const pinned = json(join(source, "release/node-static.json")).archives[arch];
    assert.deepEqual(release.staticBuild.node, pinned);
    // The Docker export precedes the identity and rg additions made by the builder.
    for (const [file, hash] of checksumEntries(release.staticBuild.files)) {
      const path = file.replace(/^\.\//, "").replace(/^native\//, "dist/native/");
      assert.equal(actual.get(path), hash, path);
    }
    assert.equal(actual.get("dist/native/bin/tmux"), identity.tmuxBinary);
    assert.equal(actual.get("dist/native/bin/rename-noreplace"), identity.helperBinary);
    assert.equal(identity.patch, digest(join(source, "native/tmux/paste.patch")));
    assert.equal(identity.helper, digest(join(source, "native/linux/rename-noreplace.c")));
  } else {
    for (const [file, hash] of Object.entries(identity.files))
      assert.equal(actual.get(file.replace(/^native\//, "dist/native/")), hash, file);
  }
  assert.ok([...actual.keys()].some((file) => file.startsWith("dist/native/licenses/")));
  for (const file of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
    assert.ok(actual.has(`dist/native/licenses/ripgrep/${file}`), `Missing rg material: ${file}`);
  if (platform === "windows") {
    const recipe = json(join(source, "release/agent-windows.json"));
    for (const [file, input] of Object.entries(recipe.sources))
      assert.equal(actual.get(`dist/native/sources/${file}`), input.sha256, file);
  }
} else {
  assert.ok(readFileSync(join(directory, "web/dist/licenses/dependencies.md"), "utf8").trim());
  for (const target of agentTargets) {
    const { archive: file } = packageNames("agent", version, target);
    for (const suffix of ["", ".sha256"])
      same(`downloads/${file}${suffix}`, join(source, "dist/releases", file + suffix));
  }
}
console.log(
  JSON.stringify({
    archive: basename(archive),
    sha256: archiveSha,
    sourceCommit: release.sourceCommit,
    files: actual.size,
    links,
  }),
);
