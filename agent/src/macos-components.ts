import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageDirectory } from "./installation.js";

export async function checkMacosComponents(signal?: AbortSignal) {
  const identity = JSON.parse(
    await readFile(join(packageDirectory, "dist/native/identity.json"), "utf8"),
  );
  const release = JSON.parse(await readFile(join(packageDirectory, "release.json"), "utf8"));
  if (
    release.kind !== "agent" ||
    release.platform !== "macos" ||
    release.architecture !== process.arch ||
    identity.linkage !== "macos-system" ||
    identity.architecture !== process.arch ||
    identity.node !== process.version
  )
    throw new Error("macOS components do not match the current release identity");
  for (const file of [
    "runtime/bin/node",
    ...["tmux", "rg", "flock", "rename-noreplace", "entry-name"].map(
      (name) => `native/bin/${name}`,
    ),
    "native/share/terminfo/74/tmux-256color",
  ]) {
    signal?.throwIfAborted();
    const hash = createHash("sha256");
    const path = join(packageDirectory, file.startsWith("native/") ? `dist/${file}` : file);
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
    if (hash.digest("hex") !== identity.files?.[file])
      throw new Error(`macOS component checksum mismatch: ${file}`);
  }
  return identity as { linkage: "macos-system"; tmux: string };
}
