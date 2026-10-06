import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, fetchPinned, json, run } from "./release-inputs.mjs";
import { staticNodeInput } from "./release-artifacts.mjs";
import { prepareRipgrep } from "./prepare-ripgrep.mjs";

const root = resolve(import.meta.dirname, "..");

export function buildLinuxComponents(destination, architecture = "amd64") {
  const release = json(join(root, "release/inputs.json"));
  const nodeArchitecture = release.nodeArchives[architecture]?.architecture;
  if (!nodeArchitecture) throw new Error(`Unsupported Linux agent architecture: ${architecture}`);
  const nodeRecipe = json(join(root, "release/node-static.json"));
  const nodeArchive = staticNodeInput(release.node, nodeRecipe, architecture);
  const recipe = json(join(root, "release/agent-linux.json"));
  const cache = "/var/tmp/kiteline-release-cache/static-sources";
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
    for (const [name, input] of Object.entries(downloads)) {
      const cached = join(cache, input.sha256);
      fetchPinned(input, cached);
      const target = join(temporary, name);
      mkdirSync(resolve(target, ".."), { recursive: true });
      cpSync(cached, target);
    }
    const files = {
      Dockerfile: "release/Dockerfile.agent-linux",
      "packages.txt": "release/agent-linux-packages.txt",
      "build-linux-native.sh": "scripts/build-linux-native.sh",
      "tmux-paste.patch": "native/tmux/paste.patch",
      "rename-noreplace.c": "native/linux/rename-noreplace.c",
      "tmux.terminfo": "native/tmux/tmux.terminfo",
    };
    for (const [name, file] of Object.entries(files))
      cpSync(join(root, file), join(temporary, name));
    const toolchain = { image: recipe.alpine, packages: digest(join(temporary, "packages.txt")) };
    const nativeInputs = {
      architecture: nodeArchitecture,
      sources: { tmux: release.tmux, ...sources },
      toolchain,
      recipe: digest(join(temporary, "build-linux-native.sh")),
      patch: digest(join(temporary, "tmux-paste.patch")),
      helper: digest(join(temporary, "rename-noreplace.c")),
      terminfo: digest(join(temporary, "tmux.terminfo")),
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
          helper: nativeInputs.helper,
          terminfo: nativeInputs.terminfo,
          terminfoResources: {
            modern: digest(join(native, "share/terminfo/t/tmux-256color")),
            legacy: digest(join(native, "share/terminfo-legacy/t/tmux-256color")),
          },
          tmuxBinary: digest(join(native, "bin/tmux")),
          helperBinary: digest(join(native, "bin/rename-noreplace")),
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
