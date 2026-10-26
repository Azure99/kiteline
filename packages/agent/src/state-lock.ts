import { open } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { windowsNative } from "@kiteline/shared/windows/native";

export function lockAgentRuntime(runDir: string) {
  if (process.platform === "win32")
    return lockWindowsDirectory({
      directory: runDir,
      fileName: "agent.lock",
      directoryKind: "run",
    });
  return lockfile.lock(join(runDir, "agent.sock"), { realpath: false });
}

export async function lockAgentState(dataDir: string) {
  const path = join(dataDir, "process.lock");
  if (process.platform !== "win32")
    return lockfile.lock(dataDir, { lockfilePath: path, realpath: false });
  return lockWindowsDirectory({
    directory: dataDir,
    fileName: "process.lock",
    directoryKind: "data",
  });
}

async function lockWindowsDirectory({
  directory,
  fileName,
  directoryKind,
}: {
  directory: string;
  fileName: string;
  directoryKind: "data" | "run";
}) {
  try {
    const path = join(directory, fileName);
    // Keep the lock file so subsequent owners lock the same object.
    const file = await open(path, "a");
    await file.close();
    const native = windowsNative();
    const handle = native.lock(path);
    return async () => native.closeHandle(handle);
  } catch (error) {
    const win32LockViolation = 33;
    if (error instanceof Error && "win32Code" in error && error.win32Code === win32LockViolation) {
      throw new Error(
        `Agent ${directoryKind} directory is already locked: ${directory} (Win32 error ${win32LockViolation})`,
        { cause: error },
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not lock agent ${directoryKind} directory ${directory}: ${reason}`, {
      cause: error,
    });
  }
}
