import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}

export function prepareRipgrep(destination) {
  const { ripgrep } = JSON.parse(readFileSync(join(root, "deploy/release.json"), "utf8"));
  const cache = "/var/tmp/kiteline-release-cache/ripgrep";
  const temporary = mkdtempSync("/var/tmp/kiteline-ripgrep-");
  try {
    mkdirSync(cache, { recursive: true });
    for (const input of [ripgrep, ripgrep.pcre2License]) {
      const cached = join(cache, input.sha256);
      if (!existsSync(cached) || digest(cached) !== input.sha256) {
        const pending = join(temporary, "download");
        run("curl", ["--fail", "--location", "--output", pending, input.url]);
        if (digest(pending) !== input.sha256)
          throw new Error(`ripgrep input checksum mismatch: ${input.url}`);
        renameSync(pending, cached);
      }
    }
    run("tar", ["-xzf", join(cache, ripgrep.sha256), "-C", temporary]);
    const source = join(temporary, `ripgrep-${ripgrep.version}-x86_64-unknown-linux-musl`);
    const binary = join(source, "rg");
    if (
      /INTERP/.test(run("readelf", ["-l", binary])) ||
      /NEEDED/.test(run("readelf", ["-d", binary]))
    )
      throw new Error("Bundled ripgrep must be a static ELF");
    if (/^ripgrep (\S+)/.exec(run(binary, ["--version"]))?.[1] !== ripgrep.version)
      throw new Error("ripgrep archive version mismatch");
    mkdirSync(join(destination, "bin"), { recursive: true });
    cpSync(binary, join(destination, "bin/rg"));
    const licenses = join(destination, "licenses/ripgrep");
    mkdirSync(licenses, { recursive: true });
    for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"])
      cpSync(join(source, name), join(licenses, name));
    cpSync(join(cache, ripgrep.pcre2License.sha256), join(licenses, "PCRE2-LICENCE.md"));
    return {
      ...ripgrep,
      architecture: "x64",
      linkage: "static-musl",
      binarySha256: digest(binary),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
