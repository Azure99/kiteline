import { run } from "./release-inputs.mjs";

export {
  agentTargets,
  packageNames,
  serverArchitectures,
} from "../packages/shared/src/artifacts.ts";

export const executablePathPattern = /^(?:bin|runtime\/bin|dist\/native\/bin)\//;

export function serverImageName(version, architecture) {
  return `kiteline-server:${version}-${architecture}`;
}

export function serverImageArchive(version, architecture) {
  return `kiteline-server-${version}-${architecture}.tar`;
}

export function candidateCompose(template, version) {
  const token = /\$\{KITELINE_VERSION:\?[^}]*\}/g;
  if (template.match(token)?.length !== 1)
    throw new Error(
      "Candidate Compose template must contain exactly one ${KITELINE_VERSION:?...} token",
    );
  return template.replace(token, () => `\${KITELINE_VERSION:-${version}}`);
}

export function staticNodeInput(version, recipe, architecture) {
  const name = `node-v${version}-r${recipe.recipeRevision}`;
  return {
    url: `https://github.com/Azure99/node-static-builds/releases/download/${name}/${name}-linux-${architecture}.tar.gz`,
    sha256: recipe.archives[architecture].sha256,
  };
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
