import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { absolutePath } from "@kiteline/shared/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { finished } from "node:stream/promises";
import { spawnJob } from "@kiteline/shared/windows/job";
import { BytePrefix } from "./buffers.js";
import { packageDirectory } from "./installation.js";

type Command = (file: string, args: string[]) => Promise<string>;

export const bundledRipgrep = process.arch === "x64";
export const ripgrepBinary = bundledRipgrep
  ? join(packageDirectory, "dist/native/bin", process.platform === "win32" ? "rg.exe" : "rg")
  : "rg";
export const toolRequirements = [
  { file: "git", major: 2, minor: 23 },
  ...(!bundledRipgrep ? [{ file: "rg", major: 14, minor: 0 }] : []),
];

export async function windowsExecutable(file: string, env = process.env) {
  const fullPath = (value: string) => {
    try {
      return absolutePath(value, "windows");
    } catch {
      return undefined;
    }
  };
  const name = /\.exe$/i.test(file) ? file : file + ".exe";
  const candidates = fullPath(name)
    ? [name]
    : /[/\\:]/.test(name)
      ? []
      : (
          Object.entries(env).findLast(
            ([key, value]) => key.toUpperCase() === "PATH" && value !== undefined,
          )?.[1] ?? ""
        )
          .split(";")
          .flatMap((directory) => {
            directory = directory.replace(/^"(.*)"$/, "$1");
            return fullPath(directory) ? [join(directory, name)] : [];
          });
  for (const path of candidates) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw Object.assign(new Error(`Native executable not found in the current PATH: ${file}`), {
    code: "ENOENT",
  });
}

// Installation/runtime probes share one bounded command path; Windows retains the entire Job.
export async function toolCommand(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number } = {},
) {
  const { env = process.env, timeout = 3000 } = options;
  if (process.platform !== "win32")
    return (
      await promisify(execFile)(file, args, {
        env,
        signal: options.signal,
        timeout,
        encoding: "utf8",
        maxBuffer: 16 * 1024,
      })
    ).stdout.trim();
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(options.signal ? [options.signal] : []),
  ]);
  const executable = await windowsExecutable(file, env);
  signal.throwIfAborted();
  const child = await spawnJob(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let failure: unknown;
  const stop = () => {
    try {
      child.terminate();
    } catch (error) {
      failure ??= error;
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  const stdout = new BytePrefix(16 * 1024),
    stderr = new BytePrefix(16 * 1024);
  for (const [stream, bytes] of [
    [child.stdout!, stdout],
    [child.stderr!, stderr],
  ] as const)
    stream.on("data", (data: Buffer) => {
      bytes.append(data);
      if (bytes.truncated) {
        failure ??= new Error("Tool output exceeds the size limit");
        stop();
      }
    });
  const output = Promise.all(
    [child.stdout!, child.stderr!].map((stream) =>
      finished(stream, { writable: false, cleanup: true }).catch((error) => {
        failure ??= error;
        stop();
      }),
    ),
  );
  if (signal.aborted) stop();
  const result = await child.exited.catch((error) => {
    failure ??= error;
    stop();
    return undefined;
  });
  await child.empty;
  failure ??= child.cleanupError;
  const timer = setTimeout(() => {
    child.stdout!.destroy(new Error("Tool output did not close after its Job ended"));
    child.stderr!.destroy(new Error("Tool output did not close after its Job ended"));
  }, 1000);
  try {
    await output;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
  signal.throwIfAborted();
  if (failure) throw failure;
  if (result!.code !== 0)
    throw Object.assign(new Error(stderr.text().trim() || `${file} exited with ${result!.code}`), {
      code: result!.code,
    });
  return stdout.text().trim();
}

export async function checkBundledRipgrep(command: Command) {
  const identity = JSON.parse(
    await readFile(join(packageDirectory, "dist/native/identity.json"), "utf8"),
  );
  const { ripgrep } = identity;
  if (
    !ripgrep ||
    createHash("sha256")
      .update(await readFile(ripgrepBinary))
      .digest("hex") !==
      (process.platform === "win32" ? identity.files?.["native/bin/rg.exe"] : ripgrep.binarySha256)
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
