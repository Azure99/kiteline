import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageDirectory } from "./installation.js";

type Command = (file: string, args: string[]) => Promise<string>;

export const bundledRipgrep = process.arch === "x64";
export const ripgrepBinary = bundledRipgrep ? join(packageDirectory, "dist/native/bin/rg") : "rg";
export const toolRequirements = [
  { file: "git", major: 2, minor: 23 },
  ...(!bundledRipgrep ? [{ file: "rg", major: 14, minor: 0 }] : []),
];

export async function checkBundledRipgrep(command: Command) {
  const { ripgrep } = JSON.parse(
    await readFile(join(packageDirectory, "dist/native/identity.json"), "utf8"),
  );
  if (
    !ripgrep ||
    createHash("sha256")
      .update(await readFile(ripgrepBinary))
      .digest("hex") !== ripgrep.binarySha256
  )
    throw new Error(
      "Bundled ripgrep checksum mismatch; rebuild native components or reinstall the matching agent package",
    );
  const line = (await command(ripgrepBinary, ["--version"])).split("\n")[0]!;
  if (/^ripgrep (\S+)/.exec(line)?.[1] !== ripgrep.version)
    throw new Error(`Bundled ripgrep version mismatch: ${line}`);
  return `${ripgrepBinary}; ${line}`;
}

export async function checkToolVersion(
  { file, major, minor }: { file: string; major: number; minor: number },
  command: Command,
) {
  const line = (await command(file, ["--version"])).split("\n")[0]!;
  const version = /(\d+)\.(\d+)/.exec(line);
  if (
    !version ||
    Number(version[1]) < major ||
    (Number(version[1]) === major && Number(version[2]) < minor)
  )
    throw new Error(`Requires >= ${major}.${minor}.0; current: ${line}`);
  return line;
}

export async function checkFileHelper(path: string, command: Command) {
  try {
    await command(path, []);
  } catch (error) {
    if ((error as { code?: number }).code === 2) return "Loadable; usage exit code 2";
    throw error;
  }
  throw new Error("Helper did not return the expected usage status");
}
