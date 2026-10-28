import { join } from "node:path";
import { AppError } from "@kiteline/shared/protocol";
import { msysPath, sessionFiles } from "@kiteline/shared/terminal/node";

export const sessionIdBytes = 8;

export function checkRunDir(runDir: string) {
  const { socket } = sessionFiles(join(runDir, "0".repeat(sessionIdBytes * 2)));
  if (Buffer.byteLength(process.platform === "win32" ? msysPath(socket) : socket) > 103)
    throw new AppError(
      "invalid_argument",
      "KITELINE_AGENT_RUN_DIR is too long; configure a shorter user-writable directory",
    );
}
