import { open } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { windowsNative } from "@kiteline/shared/windows/native";

export function lockAgentRuntime(runDir: string) {
  return lockfile.lock(join(runDir, "agent.sock"), { realpath: false });
}

export async function lockAgentState(dataDir: string) {
  const path = join(dataDir, "process.lock");
  if (process.platform !== "win32")
    return lockfile.lock(dataDir, { lockfilePath: path, realpath: false });
  // Keep the same object across run, bind and administrator maintenance.
  await (await open(path, "a")).close();
  const native = windowsNative();
  const handle = native.lock(path, false);
  return async () => native.closeHandle(handle);
}
