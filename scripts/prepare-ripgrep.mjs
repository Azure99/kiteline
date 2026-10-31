import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  fetchPinned,
  releaseCache,
  ripgrepInput,
  ripgrepLicenseFiles,
  run,
} from "./release-inputs.mjs";

const root = resolve(import.meta.dirname, "..");

export function prepareRipgrep(destination, architecture, preparedArchive) {
  const { ripgrep } = JSON.parse(readFileSync(join(root, "release/inputs.json"), "utf8"));
  const { download, archiveRoot } = ripgrepInput(ripgrep, `linux-${architecture}`);
  const archive = preparedArchive ?? join(releaseCache, "ripgrep", download.sha256);
  const temporary = mkdtempSync("/var/tmp/kiteline-ripgrep-");
  try {
    fetchPinned(download, archive);
    run("tar", ["-xzf", archive, "-C", temporary]);
    const source = join(temporary, archiveRoot);
    const binary = join(source, "rg");
    mkdirSync(join(destination, "bin"), { recursive: true });
    cpSync(binary, join(destination, "bin/rg"));
    const licenses = join(destination, "licenses/ripgrep");
    mkdirSync(licenses, { recursive: true });
    for (const name of ripgrepLicenseFiles) cpSync(join(source, name), join(licenses, name));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
