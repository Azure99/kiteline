import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { packageDirectory } from "./installation.js";
import { requiredWindowsComponents } from "@kiteline/shared/windows/components";

export const windowsComponentPath = (file: string) =>
  file.startsWith("native/") ? "dist/" + file : file;

export async function checkWindowsComponents(signal?: AbortSignal) {
  return verifyWindowsPackageComponents(packageDirectory, process.arch, process.version, signal);
}

export async function verifyWindowsPackageComponents(
  directory: string,
  architecture: string,
  nodeVersion: string,
  signal?: AbortSignal,
) {
  const identity = JSON.parse(await readFile(join(directory, "dist/native/identity.json"), "utf8"));
  const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  if (
    release.kind !== "agent" ||
    release.platform !== "windows" ||
    release.architecture !== architecture ||
    identity.linkage !== "windows-msys" ||
    identity.architecture !== architecture ||
    identity.node !== nodeVersion ||
    !isDeepStrictEqual(release.native, identity)
  )
    throw new Error("Windows components do not match the current release identity");
  const actual = new Set<string>();
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory)) {
      signal?.throwIfAborted();
      const file = join(directory, entry),
        key = prefix + entry;
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Windows component cannot be a link: ${key}`);
      if (stat.isDirectory()) await visit(file, key + "/");
      else if (stat.isFile()) actual.add(key);
      else throw new Error(`Unsupported Windows component: ${key}`);
    }
  }
  await visit(join(directory, "runtime"), "runtime/");
  await visit(join(directory, "dist/native"), "native/");
  actual.delete("native/identity.json");
  const recipe = JSON.parse(
    await readFile(join(directory, "dist/native/sources/recipe/deploy/agent-windows.json"), "utf8"),
  ) as { sources: Record<string, { url: string; sha256: string }> };
  const sources = Object.fromEntries(
    Object.entries(recipe.sources).map(([name, value]) => ["sources/" + name, value]),
  );
  const catalog = Object.fromEntries(
    Object.entries(identity.inputs.downloads).filter(([name]) => name.startsWith("sources/")),
  );
  if (!isDeepStrictEqual(sources, catalog))
    throw new Error("Windows corresponding source catalog does not match its build recipe");
  for (const [name, source] of Object.entries(sources))
    if (identity.files["native/" + name] !== source.sha256)
      throw new Error(`Windows corresponding source checksum mismatch: ${name}`);
  for (const file of requiredWindowsComponents(identity.inputs.downloads))
    if (!actual.has(file) || !identity.files?.[file])
      throw new Error(`Missing required Windows component: ${file}`);
  if (!isDeepStrictEqual([...actual].sort(), Object.keys(identity.files).sort()))
    throw new Error("Windows component file set does not match its identity");
  for (const file of actual) {
    signal?.throwIfAborted();
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, windowsComponentPath(file)), {
      signal,
    }))
      digest.update(chunk);
    if (digest.digest("hex") !== identity.files[file])
      throw new Error(`Windows component checksum mismatch: ${file}`);
  }
  return identity as { linkage: "windows-msys"; tmux: string; patch: string };
}
