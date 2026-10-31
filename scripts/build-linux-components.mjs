import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  digest,
  files,
  json,
  nodeInput,
  prepareInputs,
  releaseCache,
  ripgrepInput,
  run,
  staticNodeInput,
  tmuxPatchFiles,
  writeJson,
} from "./release-inputs.mjs";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";

const root = resolve(import.meta.dirname, "..");
const sourceFiles = [
  "release/agent-linux.json",
  "release/node-static.json",
  "release/Dockerfile.agent-linux",
  "release/agent-linux-packages.txt",
  "scripts/build-linux-components.mjs",
  "scripts/build-linux-native.sh",
  "scripts/release-inputs.mjs",
  "scripts/prepare-ripgrep.mjs",
  "native/tmux/series",
  ...tmuxPatchFiles(root),
  "native/linux/rename-noreplace.c",
  "native/terminal/pty-bridge.c",
  "native/tmux/tmux.terminfo",
];

export function linuxInputs(architecture) {
  const release = json(join(root, "release/inputs.json"));
  const nodeRecipe = json(join(root, "release/node-static.json"));
  const recipe = json(join(root, "release/agent-linux.json"));
  return {
    architecture,
    node: {
      version: release.node.version,
      recipeRevision: nodeRecipe.recipeRevision,
      architecture: nodeInput(release.node, `linux-${architecture}`).architecture,
    },
    alpine: recipe.alpine,
    downloads: {
      "node.tar.gz": staticNodeInput(release.node.version, nodeRecipe, architecture),
      "tmux.tar.gz": release.tmux,
      "libevent.tar.gz": release.libevent,
      ...recipe.sources,
      ...Object.fromEntries(
        Object.entries(recipe.licenses).map(([name, entry]) => [`licenses/${name}`, entry]),
      ),
      "rg.tar.gz": ripgrepInput(release.ripgrep, `linux-${architecture}`).download,
    },
    files: Object.fromEntries(sourceFiles.map((file) => [file, digest(join(root, file))])),
  };
}

export function buildLinuxComponents(destination, architecture) {
  const expected = linuxInputs(architecture);
  const release = json(join(root, "release/inputs.json"));
  const temporary = mkdtempSync("/var/tmp/kiteline-linux-");
  try {
    prepareInputs(temporary, root, sourceFiles, expected, {
      downloadCache: join(releaseCache, "static-sources"),
    });
    run("tar", ["-xzf", join(temporary, "node.tar.gz"), "-C", temporary]);
    const nodeBuild = json(join(temporary, "runtime/build.json"));
    if (
      nodeBuild.nodeVersion !== expected.node.version ||
      nodeBuild.recipeRevision !== expected.node.recipeRevision ||
      nodeBuild.architecture !== architecture
    )
      throw new Error(
        `Static Node component must match Node ${expected.node.version}, recipe revision ${expected.node.recipeRevision} and architecture ${architecture}`,
      );
    const output = join(temporary, "output");
    run("docker", [
      "build",
      "--platform",
      `linux/${architecture}`,
      "--build-arg",
      `ALPINE=${expected.alpine}`,
      "--build-arg",
      `NODE_ARCH=${expected.node.architecture}`,
      "--build-arg",
      "HTTP_PROXY",
      "--build-arg",
      "HTTPS_PROXY",
      "--build-arg",
      "NO_PROXY",
      "-f",
      join(temporary, "release/Dockerfile.agent-linux"),
      "--output",
      `type=local,dest=${output}`,
      temporary,
    ]);
    const native = join(output, "native");
    prepareRipgrep(native, architecture, join(temporary, "rg.tar.gz"));
    writeJson(join(native, "identity.json"), {
      linkage: "static-musl",
      node: `v${expected.node.version}`,
      architecture: expected.node.architecture,
      tmux: expected.downloads["tmux.tar.gz"].version,
      ripgrep: { version: release.ripgrep.version },
      inputs: expected,
      files: files(output),
    });
    mkdirSync(destination);
    run("cp", ["-a", `${output}/.`, destination]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
