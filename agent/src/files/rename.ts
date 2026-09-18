import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { getSystemErrorName } from "node:util";
import { OperationError } from "@kiteline/shared/protocol";

const helper = resolve(import.meta.dirname, "../../../dist/native/bin/rename-noreplace");

// The caller holds the publication lock until close; a started rename cannot be cancelled.
export function renameNoReplace(source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [source, target], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      if (code === 1 && /^\d+\n$/.test(stderr)) {
        const errno = -Number(stderr.trim());
        const code = getSystemErrorName(errno);
        return reject(Object.assign(new Error(`${code}: ${source} -> ${target}`), { code }));
      }
      reject(new OperationError("io_error", "文件发布结果未确认，请刷新核对", "unknown"));
    });
  });
}
