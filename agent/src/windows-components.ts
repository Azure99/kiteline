import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { packageDirectory } from "./installation.js";
import {
  isWindowsRuntimeComponent,
  windowsComponentPath,
  windowsRuntimeFiles,
} from "@kiteline/shared/windows/components";

export async function checkWindowsComponents(signal?: AbortSignal) {
  const identity = JSON.parse(
    await readFile(join(packageDirectory, "dist/native/identity.json"), "utf8"),
  );
  const release = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
  if (
    release.kind !== "agent" ||
    release.platform !== "windows" ||
    release.architecture !== process.arch ||
    identity.linkage !== "windows-msys" ||
    identity.architecture !== process.arch ||
    identity.node !== process.version
  )
    throw new Error("Windows components do not match the current release identity");
  const actual = new Set<string>();
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory)) {
      signal?.throwIfAborted();
      const file = join(directory, entry),
        key = prefix + entry;
      if (!isWindowsRuntimeComponent(key)) continue;
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Windows component cannot be a link: ${key}`);
      if (stat.isDirectory()) await visit(file, key + "/");
      else if (stat.isFile()) actual.add(key);
      else throw new Error(`Unsupported Windows component: ${key}`);
    }
  }
  await visit(join(packageDirectory, "runtime"), "runtime/");
  await visit(join(packageDirectory, "dist/native"), "native/");
  for (const file of windowsRuntimeFiles)
    if (!actual.has(file) || !identity.files?.[file])
      throw new Error(`Missing required Windows component: ${file}`);
  if (
    !isDeepStrictEqual(
      [...actual].sort(),
      Object.keys(identity.files).filter(isWindowsRuntimeComponent).sort(),
    )
  )
    throw new Error("Windows component file set does not match its identity");
  for (const file of actual) {
    signal?.throwIfAborted();
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(join(packageDirectory, windowsComponentPath(file)), {
      signal,
    }))
      digest.update(chunk);
    if (digest.digest("hex") !== identity.files[file])
      throw new Error(`Windows component checksum mismatch: ${file}`);
  }
  return identity as { linkage: "windows-msys"; tmux: string; patch: string };
}
