import { capture, nodeInput } from "./release-inputs.mjs";

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

export function expectedRelease(inputs, version, kind, target, sourceCommit) {
  const [platform] = target.split("-");
  return {
    kind,
    platform,
    version,
    architecture: nodeInput(inputs.node, target).architecture,
    node: inputs.node.version,
    sourceCommit,
  };
}

export function sourceCommit(root) {
  const options = { cwd: root };
  const commit = capture("git", ["rev-parse", "HEAD"], options);
  if (capture("git", ["status", "--porcelain"], options))
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
