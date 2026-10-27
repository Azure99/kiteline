import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digest,
  fetchPinned,
  json,
  prepareInputs,
  releaseCache,
  run,
  tmuxPatchFiles,
} from "./release-inputs.mjs";
import { staticNodeInput } from "./release-artifacts.mjs";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";

const root = resolve(import.meta.dirname, "..");
const sourceFiles = [
  "release/Dockerfile.agent-linux",
  "release/agent-linux-packages.txt",
  "scripts/build-linux-native.sh",
  "native/tmux/series",
  ...tmuxPatchFiles(root),
  "native/linux/rename-noreplace.c",
  "native/terminal/pty-bridge.c",
  "native/tmux/tmux.terminfo",
];

export function buildLinuxComponents(destination, architecture = "amd64") {
  const release = json(join(root, "release/inputs.json"));
  const nodeArchitecture = release.nodeArchives[architecture]?.architecture;
  if (!nodeArchitecture) throw new Error(`Unsupported Linux agent architecture: ${architecture}`);
  const nodeRecipe = json(join(root, "release/node-static.json"));
  const nodeArchive = staticNodeInput(release.node, nodeRecipe, architecture);
  const recipe = json(join(root, "release/agent-linux.json"));
  const cache = join(releaseCache, "static-sources");
  const temporary = mkdtempSync("/var/tmp/kiteline-linux-");
  let container;
  let failed = false;
  const cleanupErrors = [];
  try {
    mkdirSync(cache, { recursive: true });
    const cachedNode = join(cache, nodeArchive.sha256);
    fetchPinned(nodeArchive, cachedNode);
    run("tar", ["-xzf", cachedNode, "-C", temporary]);
    const nodeBuild = JSON.parse(readFileSync(join(temporary, "runtime/build.json"), "utf8"));
    if (
      nodeBuild.nodeVersion !== release.node ||
      nodeBuild.recipeRevision !== nodeRecipe.recipeRevision ||
      nodeBuild.architecture !== architecture
    )
      throw new Error(
        `Static Node component must match Node ${release.node}, recipe revision ${nodeRecipe.recipeRevision} and architecture ${architecture}`,
      );
    const sources = { "libevent.tar.gz": release.libevent, ...recipe.sources };
    const downloads = {
      "tmux.tar.gz": release.tmux,
      ...sources,
      ...Object.fromEntries(
        Object.entries(recipe.licenses).map(([name, entry]) => [`licenses/${name}`, entry]),
      ),
    };
    const expected = {
      downloads,
      files: Object.fromEntries(sourceFiles.map((file) => [file, digest(join(root, file))])),
    };
    prepareInputs(temporary, root, sourceFiles, expected, { downloadCache: cache });
    const toolchain = {
      image: recipe.alpine,
      packages: expected.files["release/agent-linux-packages.txt"],
    };
    const nativeInputs = {
      architecture: nodeArchitecture,
      sources: { tmux: release.tmux, ...sources },
      toolchain,
      recipe: expected.files["scripts/build-linux-native.sh"],
      patch: expected.files["native/tmux/paste.patch"],
      flowControlPatch: expected.files["native/tmux/flow-control.patch"],
      helper: expected.files["native/linux/rename-noreplace.c"],
      ptyBridge: expected.files["native/terminal/pty-bridge.c"],
      terminfo: expected.files["native/tmux/tmux.terminfo"],
    };
    writeFileSync(
      join(temporary, "native-inputs.json"),
      JSON.stringify(nativeInputs, null, 2) + "\n",
    );
    const imageFile = join(temporary, "image-id");
    run("docker", [
      "build",
      "--platform",
      `linux/${architecture}`,
      "--build-arg",
      `ALPINE=${recipe.alpine}`,
      "--build-arg",
      `NODE_ARCH=${nodeArchitecture}`,
      "--build-arg",
      "HTTP_PROXY",
      "--build-arg",
      "HTTPS_PROXY",
      "--build-arg",
      "NO_PROXY",
      "-f",
      join(temporary, "release/Dockerfile.agent-linux"),
      "--iidfile",
      imageFile,
      temporary,
    ]);
    const image = readFileSync(imageFile, "utf8").trim();
    container = run("docker", ["create", image, "/unused"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
    const output = join(temporary, "output");
    run("docker", ["cp", `${container}:/output`, output]);
    writeFileSync(
      join(output, "build.json"),
      JSON.stringify(
        {
          linkage: "static-musl",
          architecture: nodeArchitecture,
          image,
          node: nodeArchive,
          native: nativeInputs,
          files: readFileSync(join(output, "SHA256SUMS"), "utf8"),
        },
        null,
        2,
      ) + "\n",
    );
    const native = join(output, "native");
    writeFileSync(
      join(native, "identity.json"),
      JSON.stringify(
        {
          linkage: "static-musl",
          node: `v${release.node}`,
          architecture: nodeArchitecture,
          tmux: nativeInputs.sources.tmux.version,
          tmuxSource: nativeInputs.sources.tmux.sha256,
          patch: nativeInputs.patch,
          flowControlPatch: nativeInputs.flowControlPatch,
          helper: nativeInputs.helper,
          ptyBridge: nativeInputs.ptyBridge,
          terminfo: nativeInputs.terminfo,
          terminfoResources: {
            modern: digest(join(native, "share/terminfo/t/tmux-256color")),
            legacy: digest(join(native, "share/terminfo-legacy/t/tmux-256color")),
          },
          tmuxBinary: digest(join(native, "bin/tmux")),
          helperBinary: digest(join(native, "bin/rename-noreplace")),
          ptyBridgeBinary: digest(join(native, "bin/pty-bridge")),
          ripgrep: prepareRipgrep(native, architecture),
        },
        null,
        2,
      ) + "\n",
    );
    mkdirSync(resolve(destination, ".."), { recursive: true });
    const pending = mkdtempSync(`${destination}.pending-`);
    try {
      run("cp", ["-a", `${output}/.`, pending]);
      rmSync(destination, { force: true, recursive: true });
      renameSync(pending, destination);
    } finally {
      rmSync(pending, { force: true, recursive: true });
    }
    console.log(`Linux agent components: ${destination}`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (container) run("docker", ["rm", container]);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (failed)
      for (const error of cleanupErrors) console.error("Linux build cleanup failed:", error);
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Linux build cleanup failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [architecture = "amd64", extra] = process.argv.slice(2);
  if (extra) throw new Error("Usage: node scripts/build-linux-components.mjs [amd64|arm64]");
  buildLinuxComponents(
    resolve(process.env.KITELINE_LINUX_OUTPUT ?? join(root, `dist/agent-linux-${architecture}`)),
    architecture,
  );
}
