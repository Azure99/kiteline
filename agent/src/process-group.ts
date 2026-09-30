import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function groupRunning(pid: number) {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
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

export async function waitForGroup(pid: number, onError: (error: unknown) => void) {
  let interval = 50;
  while (true) {
    try {
      if (!(await groupRunning(pid))) return;
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
