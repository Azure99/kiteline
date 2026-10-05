import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { AppError, limits } from "../protocol/index.js";
import type { CreateTerminal } from "../protocol/ipc.js";
import { JobChild, spawnJob } from "../windows/job.js";

const root = resolve(import.meta.dirname, "../../..");
export const tmuxSession = "kiteline";
export const msysDirectory = resolve(root, "dist/native/msys");
export const tmuxBinary =
  process.platform === "win32"
    ? resolve(msysDirectory, "usr/bin/tmux.exe")
    : resolve(root, "dist/native/bin/tmux");
export const terminfoDirectory =
  process.platform === "win32"
    ? resolve(msysDirectory, "usr/share/terminfo")
    : resolve(root, "dist/native/share/terminfo");
export const exitCodeFormat =
  process.platform === "win32" ? "#{@kiteline-exit-dword}" : "#{pane_dead_status}";

export function msysPath(path: string) {
  return path.replaceAll("\\", "/");
}
export function shellWords(args: string[]) {
  return args.map((value) => "'" + value.replaceAll("'", "'\\''") + "'").join(" ");
}
export const nodeEnvironmentKeys = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_ICU_DATA",
  "NODE_REDIRECT_WARNINGS",
  "NODE_V8_COVERAGE",
  "OPENSSL_CONF",
];
export function internalNodeEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (nodeEnvironmentKeys.includes(key.toUpperCase())) delete environment[key];
  return environment;
}
export function tmuxEnvironment() {
  if (process.platform === "win32") {
    const environment = internalNodeEnvironment();
    for (const key of Object.keys(environment))
      if (
        /^(PATH|SHELL|TERM|TERMINFO|TERMINFO_DIRS|TMUX|MSYS|MSYS2_ARG_CONV_EXCL|MSYS2_ENV_CONV_EXCL|LC_ALL|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(
          key,
        )
      )
        delete environment[key];
    return {
      ...environment,
      PATH: `${resolve(msysDirectory, "usr/bin")};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
      SHELL: "/usr/bin/bash",
      TERM: "xterm-256color",
      TERMINFO: "/usr/share/terminfo",
      LC_ALL: "C.UTF-8",
      MSYS: "noglob",
      MSYS2_ARG_CONV_EXCL: "*",
      MSYS2_ENV_CONV_EXCL: "*",
    };
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TERMINFO_DIRS:
      [
        terminfoDirectory,
        process.platform === "linux" ? `${terminfoDirectory}-legacy` : undefined,
        process.env.TERMINFO_DIRS,
      ]
        .filter(Boolean)
        .join(":") + ":",
  };
  delete environment.TMUX;
  return environment;
}
export function terminalPreset(options: CreateTerminal) {
  return [
    ...(process.platform === "win32" ? ["set -g default-shell /usr/bin/bash"] : []),
    "set -g status off",
    "set -g window-size latest",
    "set -g default-terminal tmux-256color",
    `set -g history-limit ${options.historyLines}`,
    `set -g default-size ${options.cols}x${options.rows}`,
    "set -g remain-on-exit on",
    "set -g mouse on",
    "set -g allow-passthrough off",
    "set -g set-clipboard external",
    "unbind-key -a -T prefix",
    "bind-key -T prefix C-b send-prefix",
    "bind-key -T prefix d detach-client",
    "bind-key -T prefix [ copy-mode",
    "bind-key -T prefix ] paste-buffer -p",
    "bind-key -T root MouseDown3Pane send-keys -M",
    "unbind-key -T root M-MouseDown3Pane",
    "",
  ].join("\n");
}
export function tmuxServerMissing(error: unknown) {
  return (
    error instanceof Error &&
    /no server running|No such file or directory|Connection refused/.test(error.message)
  );
}

export async function tmux(
  socket: string,
  args: string[],
  input?: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  let child;
  if (process.platform === "win32") {
    signal?.throwIfAborted();
    child = await spawnJob(tmuxBinary, ["-N", "-S", msysPath(socket), ...args], {
      env: tmuxEnvironment(),
    });
  } else
    child = spawn(tmuxBinary, ["-S", socket, ...args], {
      env: { ...tmuxEnvironment(), LC_ALL: "C.UTF-8" },
      stdio: "pipe",
      signal,
    });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let errorBytes = 0;
  child.stdout!.on("data", (data: Buffer) => {
    outputBytes += data.length;
    if (outputBytes <= limits.controlMessageBytes) stdout.push(data);
  });
  child.stderr!.on("data", (data: Buffer) => {
    errorBytes += data.length;
    if (errorBytes <= 8192) stderr.push(data);
  });
  child.stdin!.on("error", () => {});
  let code: number | null;
  if (child instanceof JobChild) {
    const job = child;
    const drained = Promise.all([
      finished(job.stdout!, { writable: false, cleanup: true }),
      finished(job.stderr!, { writable: false, cleanup: true }),
    ]);
    void drained.catch(() => {});
    const stop = () => job.terminate();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    job.stdin!.end(input ?? Buffer.alloc(0));
    try {
      ({ code } = await job.exited);
    } finally {
      await job.stop();
      signal?.removeEventListener("abort", stop);
      await drained;
    }
    signal?.throwIfAborted();
  } else {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin!.end(input);
    code = await exited;
  }
  if (outputBytes > limits.controlMessageBytes)
    throw new AppError("limit_exceeded", "tmux output exceeds the size limit");
  if (code !== 0)
    throw new AppError(
      "command_failed",
      Buffer.concat(stderr).toString().trim() || `tmux exited ${code}`,
    );
  return Buffer.concat(stdout).toString();
}
