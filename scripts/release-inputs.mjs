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

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}

export const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const json = (file) => JSON.parse(readFileSync(file, "utf8"));

export function ripgrepInput(version, input) {
  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${version}/ripgrep-${version}-${input.archiveSuffix}`,
    sha256: input.sha256,
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

export function prepareInputs(directory, root, sourceFiles, expected) {
  mkdirSync(directory, { recursive: true });
  for (const [file, input] of Object.entries(expected.downloads))
    fetchPinned(input, join(directory, file));
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
