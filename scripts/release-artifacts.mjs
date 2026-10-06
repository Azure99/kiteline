import { run } from "./release-inputs.mjs";

export const agentTargets = [
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "macos-amd64",
  "macos-arm64",
];

export function staticNodeInput(version, recipe, architecture) {
  const name = `node-v${version}-r${recipe.recipeRevision}`;
  return {
    url: `https://github.com/Azure99/node-static-builds/releases/download/${name}/${name}-linux-${architecture}.tar.gz`,
    sha256: recipe.archives[architecture].sha256,
  };
}

export function packageNames(kind, version, target) {
  const name = `kiteline-${kind}-${version}-${target}`;
  return { name, archive: `${name}.${target.startsWith("windows-") ? "zip" : "tar.gz"}` };
}

export function expectedRelease(inputs, version, kind, target, sourceCommit) {
  const [platform, arch] = target.split("-");
  return {
    kind,
    platform,
    version,
    architecture: inputs.nodeArchives[arch].architecture,
    node: inputs.node,
    sourceCommit,
  };
}

export function sourceCommit(root) {
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  const commit = run("git", ["rev-parse", "HEAD"], options).trim();
  if (run("git", ["status", "--porcelain"], options).trim())
    throw new Error("Release builds require a clean Git worktree and index");
  return commit;
}

export function releaseMatches(manifest, expected) {
  return (
    manifest.sourceDirty === false &&
    ["kind", "platform", "version", "architecture", "node", "sourceCommit"].every(
      (key) => manifest[key] === expected[key],
    )
  );
}
