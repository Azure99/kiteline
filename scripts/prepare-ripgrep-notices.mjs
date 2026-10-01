import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export function prepareRipgrepNotices(directory, destination) {
  const { ripgrep } = JSON.parse(readFileSync(join(root, "deploy/release.json"), "utf8"));
  for (const [name, input] of Object.entries(ripgrep.notices)) {
    const source = join(directory, "licenses/ripgrep", name);
    const target = join(destination, "licenses/ripgrep", name);
    mkdirSync(dirname(target), { recursive: true });
    if (input.member)
      writeFileSync(
        target,
        execFileSync("tar", ["-xOf", source, input.member], { maxBuffer: 8 * 1024 * 1024 }),
      );
    else cpSync(source, target);
  }
}
