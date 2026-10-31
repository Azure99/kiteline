import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  agentTargets,
  executablePathPattern,
  expectedRelease,
  packageNames,
  releaseMatches,
  serverArchitectures,
  sourceCommit,
} from "./release-artifacts.mjs";
import {
  componentPackagePath,
  digest,
  json,
  nodeInput,
  ripgrepLicenseFiles,
  staticNodeInput,
} from "./release-inputs.mjs";
import { linuxInputs } from "./build-linux-components.mjs";
import { windowsCliLauncher } from "./agent-launcher.ts";
import { terminalReset } from "../packages/cli/src/terminal-reset.ts";

const [kind, target, archivePath, directoryPath, extra] = process.argv.slice(2);
if (!archivePath || !directoryPath || extra || !["agent", "server", "cli"].includes(kind))
  throw new Error(
    "Usage: node scripts/verify-package.mjs agent|server|cli PLATFORM-ARCH ARCHIVE DIRECTORY",
  );
const source = process.cwd();
const archive = resolve(archivePath);
const directory = realpathSync(directoryPath);
const inputs = json(join(source, "release/inputs.json"));
const { version } = json(join(source, "packages/shared/src/version.json"));
const [platform, arch] = target.split("-");
assert.ok(
  kind === "server"
    ? platform === "linux" && serverArchitectures.includes(arch)
    : agentTargets.includes(target),
);
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
      if (platform !== "windows" && executablePathPattern.test(key))
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
same(
  "shared/licenses/proxy-agent-negotiate.txt",
  join(source, "packages/shared/licenses/proxy-agent-negotiate.txt"),
);
assert.ok(readFileSync(join(directory, "runtime/LICENSE"), "utf8").trim());

const nodePath = join(directory, "runtime/bin", platform === "windows" ? "node.exe" : "node");
const node = readFileSync(nodePath);
if (platform === "linux") {
  const elfMagic = "7f454c46";
  const elfMachineOffset = 18;
  const elfMachine = { amd64: 62, arm64: 183 };
  assert.equal(
    node.subarray(0, 4).toString("hex"),
    elfMagic,
    `${nodePath}: ELF magic must match ${target}`,
  );
  assert.equal(
    node.readUInt16LE(elfMachineOffset),
    elfMachine[arch],
    `${nodePath}: ELF e_machine must match ${target}`,
  );
} else if (platform === "windows") {
  const dosMagic = "MZ";
  const dosPeHeaderPointerOffset = 0x3c;
  const peMachineOffsetFromHeader = 4;
  const peMachineAmd64 = 0x8664;
  assert.equal(
    node.subarray(0, 2).toString(),
    dosMagic,
    `${nodePath}: DOS MZ magic must match ${target}`,
  );
  const peHeaderOffset = node.readUInt32LE(dosPeHeaderPointerOffset);
  assert.equal(
    node.readUInt16LE(peHeaderOffset + peMachineOffsetFromHeader),
    peMachineAmd64,
    `${nodePath}: PE Machine must match ${target}`,
  );
} else {
  const machOMagic64LittleEndian = 0xfeedfacf;
  const machOCpuTypeOffset = 4;
  const machOCpuType = { amd64: 0x01000007, arm64: 0x0100000c };
  assert.equal(
    node.readUInt32LE(0),
    machOMagic64LittleEndian,
    `${nodePath}: Mach-O 64-bit little-endian magic must match ${target}`,
  );
  assert.equal(
    node.readUInt32LE(machOCpuTypeOffset),
    machOCpuType[arch],
    `${nodePath}: Mach-O cpuType must match ${target}`,
  );
}

if (kind !== "server") {
  const entry = `kiteline${platform === "windows" ? ".ps1" : ""}`;
  if (platform === "windows") {
    assert.equal(
      readFileSync(join(directory, "bin", entry), "utf8"),
      windowsCliLauncher(terminalReset),
      entry,
    );
  } else same(`bin/${entry}`, join(source, "installer", entry));
  assert.ok(actual.has("cli/dist/main.js"));
  assert.deepEqual(
    [...actual.keys()].filter((file) => /(?:^|\/)node(?:\.exe)?$/.test(file)),
    [`runtime/bin/node${platform === "windows" ? ".exe" : ""}`],
    "Portable package must contain one shared Node runtime",
  );
}
if (kind === "cli") {
  assert.ok(
    ![...actual.keys()].some((file) =>
      /^(agent|terminal-recorder|dist\/native|web|downloads)\//.test(file),
    ),
  );
  if (platform === "linux") {
    assert.equal(
      release.nodeArchive,
      staticNodeInput(inputs.node.version, json(join(source, "release/node-static.json")), arch)
        .sha256,
    );
    const build = json(join(directory, "runtime/build.json"));
    assert.equal(build.nodeVersion, inputs.node.version);
    assert.equal(build.architecture, arch);
    assert.ok(actual.has("runtime/licenses/musl-COPYRIGHT"));
  } else {
    assert.equal(release.nodeArchive, nodeInput(inputs.node, target).download.sha256);
  }
}

if (kind === "agent") {
  const identity = json(join(directory, "dist/native/identity.json"));
  assert.equal(identity.node, `v${inputs.node.version}`);
  assert.equal(identity.architecture, nodeInput(inputs.node, target).architecture);
  assert.equal(identity.tmux, inputs.tmux.version);
  assert.equal(identity.ripgrep.version, inputs.ripgrep.version);
  if (platform === "linux") {
    assert.equal(identity.linkage, "static-musl");
    assert.deepEqual(identity.inputs, linuxInputs(arch), "Linux component inputs differ");
  }
  for (const [file, hash] of Object.entries(identity.files))
    assert.equal(actual.get(componentPackagePath(file)), hash, file);
  assert.ok([...actual.keys()].some((file) => file.startsWith("dist/native/licenses/")));
  for (const file of ripgrepLicenseFiles)
    assert.ok(actual.has(`dist/native/licenses/ripgrep/${file}`), `Missing rg material: ${file}`);
  if (platform === "windows") {
    const recipe = json(join(source, "release/agent-windows.json"));
    for (const [file, input] of Object.entries(recipe.sources))
      assert.equal(actual.get(`dist/native/sources/${file}`), input.sha256, file);
  }
} else if (kind === "server") {
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
