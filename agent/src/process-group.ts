import { readFile, readdir } from "node:fs/promises";
import { write } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export async function groupRunning(pid: number) {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (process.platform !== "darwin" || (error as NodeJS.ErrnoException).code !== "EPERM")
      throw error;
  }
  if (process.platform === "darwin") {
    const { stdout, stderr } = await promisify(execFile)(
      "/bin/ps",
      ["-ax", "-o", "pgid=", "-o", "stat="],
      {
        env: { ...process.env, LC_ALL: "C" },
        timeout: 2000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (stderr.trim() || !stdout.trim()) throw new Error("Cannot read the process group snapshot");
    let running = false;
    for (const line of stdout.trim().split("\n")) {
      const fields = /^\s*(\d+)\s+([A-Z])\S*\s*$/.exec(line);
      if (!fields) throw new Error("Cannot parse the process group snapshot");
      if (Number(fields[1]) === pid && fields[2] !== "Z") running = true;
    }
    return running;
  }
  // Linux keeps exited descendants as zombies until their parent reaps them.
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const value = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") throw error;
    }
  }
  return false;
}

function temporary(error: unknown) {
  const { code, killed, signal } = error as {
    code?: string | number | null;
    killed?: boolean;
    signal?: string;
  };
  return (
    ["EINTR", "EAGAIN", "ENOMEM"].includes(String(code)) ||
    (code == null && killed && signal === "SIGKILL")
  );
}

function failMacosGroup(pid: number, error: unknown): Promise<false> {
  let cleanup: unknown;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ESRCH") return Promise.resolve(false);
    cleanup = reason;
  }
  const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
  const diagnostic = Buffer.from(
    `Fatal process group ${pid}: ${message(error)}${cleanup ? `; kill: ${message(cleanup)}` : ""}\n`,
  ).subarray(0, 4096);
  // Keep the caller unsettled; synchronous stderr can block before an exit timer can run.
  return new Promise(() => {
    const exit = () => process.exit(1);
    setTimeout(exit, 100);
    try {
      write(2, diagnostic, exit);
    } catch {
      exit();
    }
  });
}

async function macosGroupRunning(pid: number): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await groupRunning(pid);
    } catch (error) {
      try {
        process.kill(-pid, 0);
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === "ESRCH") return false;
      }
      if (attempt >= 2 || !temporary(error)) return failMacosGroup(pid, error);
      await delay(50);
    }
  }
}

async function signalMacosGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if (!(await macosGroupRunning(pid))) return;
      if (attempt >= 2 || !temporary(error)) {
        await failMacosGroup(pid, error);
        return;
      }
      await delay(50);
    }
  }
}

export async function waitForGroup(pid: number, onError: (error: unknown) => void) {
  let interval = 50;
  while (true) {
    try {
      if (!(await (process.platform === "darwin" ? macosGroupRunning(pid) : groupRunning(pid))))
        return;
    } catch (error) {
      onError(error);
    }
    await delay(interval);
    interval = Math.min(interval * 2, 500);
  }
}

export async function stopGroup(
  pid: number,
  done: Promise<void>,
  grace: number,
  onError: (error: unknown) => void,
) {
  if (process.platform === "darwin") {
    await signalMacosGroup(pid, "SIGTERM");
    let escalation: Promise<void> | undefined;
    const timer = setTimeout(() => {
      escalation = signalMacosGroup(pid, "SIGKILL");
    }, grace);
    try {
      await done;
      await escalation;
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") onError(error);
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), grace);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}
