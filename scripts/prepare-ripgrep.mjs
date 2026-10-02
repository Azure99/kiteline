import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { digest, fetchPinned, run as execute } from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");
function run(command, args) {
  return execute(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function prepareRipgrep(destination, architecture) {
  const { ripgrep, nodeArchives } = JSON.parse(
    readFileSync(join(root, "deploy/release.json"), "utf8"),
  );
  const input = ripgrep.linuxArchives[architecture];
  if (!input) throw new Error(`Unsupported ripgrep architecture: ${architecture}`);
  const cache = "/var/tmp/kiteline-release-cache/ripgrep";
  const temporary = mkdtempSync("/var/tmp/kiteline-ripgrep-");
  try {
    mkdirSync(cache, { recursive: true });
    fetchPinned(input, join(cache, input.sha256));
    run("tar", ["-xzf", join(cache, input.sha256), "-C", temporary]);
    const source = join(temporary, basename(new URL(input.url).pathname, ".tar.gz"));
    const binary = join(source, "rg");
    mkdirSync(join(destination, "bin"), { recursive: true });
    cpSync(binary, join(destination, "bin/rg"));
    const licenses = join(destination, "licenses/ripgrep");
    mkdirSync(licenses, { recursive: true });
    for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
      cpSync(join(source, name), join(licenses, name));
    return {
      version: ripgrep.version,
      ...input,
      architecture: nodeArchives[architecture].architecture,
      linkage: "static-musl",
      binarySha256: digest(binary),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
