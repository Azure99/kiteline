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
import { digest, fetchPinned, run } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

export function buildStaticAgent(destination, architecture = "amd64") {
  const release = json("deploy/release.json");
  const nodeArchitecture = release.nodeArchives[architecture]?.architecture;
  if (!nodeArchitecture) throw new Error(`Unsupported static agent architecture: ${architecture}`);
  const recipe = json("deploy/agent-static.json");
  const cache = "/var/tmp/kiteline-release-cache/static-sources";
  const temporary = mkdtempSync("/var/tmp/kiteline-static-");
  let container;
  let failed = false;
  const cleanupErrors = [];
  try {
    mkdirSync(cache, { recursive: true });
    const node = {
      url: `https://nodejs.org/dist/v${release.node}/node-v${release.node}.tar.xz`,
      sha256: recipe.nodeSourceSha256,
    };
    const sources = { "node.tar.xz": node, "tmux.tar.gz": recipe.tmux, ...recipe.sources };
    const downloads = {
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
      Dockerfile: "deploy/Dockerfile.agent-static",
      "packages.txt": "deploy/agent-static-packages.txt",
      "build-static-node.sh": "scripts/build-static-node.sh",
      "build-static-native.sh": "scripts/build-static-native.sh",
      "tmux-paste.patch": "native/tmux-paste.patch",
      "rename-noreplace.c": "native/rename-noreplace.c",
      "tmux.terminfo": "native/tmux.terminfo",
    };
    for (const [name, file] of Object.entries(files))
      cpSync(join(root, file), join(temporary, name));
    const toolchain = { image: recipe.alpine, packages: digest(join(temporary, "packages.txt")) };
    const nodeInputs = {
      architecture: nodeArchitecture,
      node,
      toolchain,
      recipe: digest(join(temporary, "build-static-node.sh")),
    };
    const nativeInputs = {
      architecture: nodeArchitecture,
      sources: { tmux: recipe.tmux, ...recipe.sources },
      toolchain,
      recipe: digest(join(temporary, "build-static-native.sh")),
      patch: digest(join(temporary, "tmux-paste.patch")),
      helper: digest(join(temporary, "rename-noreplace.c")),
      terminfo: digest(join(temporary, "tmux.terminfo")),
    };
    for (const [name, inputs] of Object.entries({ node: nodeInputs, native: nativeInputs }))
      writeFileSync(join(temporary, `${name}-inputs.json`), JSON.stringify(inputs, null, 2) + "\n");
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
          node: nodeInputs,
          native: nativeInputs,
          files: readFileSync(join(output, "SHA256SUMS"), "utf8"),
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
    console.log(`Static agent components: ${destination}`);
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
      for (const error of cleanupErrors) console.error("Static build cleanup failed:", error);
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Static build cleanup failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [architecture = "amd64", extra] = process.argv.slice(2);
  if (extra) throw new Error("Usage: node scripts/build-agent-static.mjs [amd64|arm64]");
  buildStaticAgent(
    resolve(process.env.KITELINE_STATIC_OUTPUT ?? join(root, `dist/agent-static-${architecture}`)),
    architecture,
  );
}
