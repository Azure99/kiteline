import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AppError, limits } from "../protocol/index.js";

const root = resolve(import.meta.dirname, "../../..");
export const tmuxBinary = resolve(root, "dist/native/bin/tmux");
export const terminfoDirectory = resolve(root, "dist/native/share/terminfo");
export function tmuxEnvironment() {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TERMINFO_DIRS: `${terminfoDirectory}:${process.env.TERMINFO_DIRS ?? ""}`,
  };
  delete environment.TMUX;
  return environment;
}
export function tmux(
  socket: string,
  args: string[],
  input?: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tmuxBinary, ["-S", socket, ...args], {
      env: { ...tmuxEnvironment(), LC_ALL: "C.UTF-8" },
      stdio: "pipe",
      signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let overflow = false;
    child.stdout.on("data", (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes <= limits.controlMessageBytes) stdout.push(data);
      else overflow = true;
    });
    child.stderr.on("data", (data: Buffer) => {
      errorBytes += data.length;
      if (errorBytes <= 8192) stderr.push(data);
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (overflow) reject(new AppError("limit_exceeded", "tmux 输出超过容量"));
      else if (code !== 0)
        reject(
          new AppError(
            "command_failed",
            Buffer.concat(stderr).toString().trim() || `tmux exited ${code}`,
          ),
        );
      else resolve(Buffer.concat(stdout).toString());
    });
    child.stdin.end(input);
  });
}
