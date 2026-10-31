import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

export const releaseCache = "/var/tmp/kiteline-release-cache";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}

export function capture(command, args, options = {}) {
  return run(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

export const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const json = (file) => JSON.parse(readFileSync(file, "utf8"));
export const componentPackagePath = (file) => (file.startsWith("native/") ? "dist/" + file : file);

export function tmuxPatchFiles(root) {
  return readFileSync(join(root, "native/tmux/series"), "utf8")
    .trimEnd()
    .split("\n")
    .map((file) => `native/tmux/${file}`);
}

export function nodeInput(node, target) {
  const input = node.archives[target];
  if (!input) throw new Error(`Unsupported Node target: ${target}`);
  const archiveName = `node-v${node.version}-${input.archiveSuffix}`;
  return {
    download: {
      url: `https://nodejs.org/dist/v${node.version}/${archiveName}`,
      sha256: input.sha256,
    },
    archiveName,
    archiveRoot: archiveName.replace(/\.(?:tar\.xz|zip)$/, ""),
    architecture: input.architecture,
  };
}

export function nodeHeadersInput(node) {
  return {
    url: `https://nodejs.org/dist/v${node.version}/node-v${node.version}-headers.tar.gz`,
    sha256: node.headers.sha256,
  };
}

export function staticNodeInput(version, recipe, architecture) {
  const name = `node-v${version}-r${recipe.recipeRevision}`;
  return {
    url: `https://github.com/Azure99/node-static-builds/releases/download/${name}/${name}-linux-${architecture}.tar.gz`,
    sha256: recipe.archives[architecture].sha256,
  };
}

export const ripgrepLicenseFiles = ["COPYING", "LICENSE-MIT", "UNLICENSE"];

export function ripgrepInput(ripgrep, target) {
  const input = ripgrep.archives[target];
  if (!input) throw new Error(`Unsupported ripgrep target: ${target}`);
  const archiveName = `ripgrep-${ripgrep.version}-${input.archiveSuffix}`;
  return {
    download: {
      url: `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrep.version}/${archiveName}`,
      sha256: input.sha256,
    },
    archiveRoot: archiveName.replace(/\.(?:tar\.gz|zip)$/, ""),
  };
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

export function files(directory, prefix = "") {
  const entries = {};
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const key = prefix + name;
    const stat = lstatSync(file);
    if (stat.isDirectory()) Object.assign(entries, files(file, key + "/"));
    else if (stat.isFile()) entries[key] = digest(file);
    else throw new Error(`Unexpected component link: ${file}`);
  }
  return entries;
}

export function prepareInputs(directory, root, sourceFiles, expected, { downloadCache } = {}) {
  mkdirSync(directory, { recursive: true });
  for (const [file, input] of Object.entries(expected.downloads)) {
    const target = join(directory, file);
    const cached = downloadCache ? join(downloadCache, input.sha256) : target;
    fetchPinned(input, cached);
    if (downloadCache) copy(cached, target);
  }
  for (const file of sourceFiles) copy(join(root, file), join(directory, file));
  writeJson(join(directory, "inputs.json"), expected);
}

export function verifyPreparedInputs(directory, expected, platform) {
  if (hash(json(join(directory, "inputs.json"))) !== hash(expected))
    throw new Error(`${platform} component inputs do not match this source; prepare them again`);
  for (const [file, input] of Object.entries(expected.downloads))
    if (digest(join(directory, file)) !== input.sha256)
      throw new Error(`${platform} component input checksum mismatch: ${file}`);
  for (const [file, sha256] of Object.entries(expected.files))
    if (digest(join(directory, file)) !== sha256)
      throw new Error(`${platform} component recipe checksum mismatch: ${file}`);
  return expected;
}

export function verifyComponentFiles(directory, identity, required, platform) {
  const actual = files(directory);
  delete actual["native/identity.json"];
  for (const file of required)
    if (!actual[file]) throw new Error(`Missing ${platform} component: ${file}`);
  if (hash(actual) !== hash(identity.files))
    throw new Error(`${platform} component checksum mismatch`);
}

export function fetchPinned(input, target) {
  if (existsSync(target) && digest(target) === input.sha256) return;
  mkdirSync(dirname(target), { recursive: true });
  const pending = `${target}.${process.pid}.pending`;
  try {
    run("curl", ["--fail", "--location", "--output", pending, input.url]);
    if (digest(pending) !== input.sha256) throw new Error(`Checksum mismatch: ${input.url}`);
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}
