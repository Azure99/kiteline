import { isUtf8 } from "node:buffer";
import { AppError, type GitPath } from "@kiteline/shared/protocol";
import { agentLimits } from "../limits.js";

export function utf8(bytes: Buffer) {
  if (!isUtf8(bytes))
    throw new AppError("unsupported", "Git output is not valid UTF-8; handle it in the terminal");
  return bytes.toString();
}
export function gitPath(bytes: Buffer, old?: Buffer): GitPath {
  if (isUtf8(bytes) && (!old || isUtf8(old)))
    return { path: bytes.toString(), ...(old ? { oldPath: old.toString() } : {}) };
  const escaped = (value: Buffer) =>
    Array.from(value, (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  return { pathError: old ? `${escaped(old)} -> ${escaped(bytes)}` : escaped(bytes) };
}
export function gitPathKey(path: GitPath) {
  return JSON.stringify([path.path, path.oldPath, path.pathError]);
}
export function literalPathspec(path: string) {
  return `:(top,literal)${path}`;
}
export function leafPathspecs(paths: string[]) {
  return paths.flatMap((path) => {
    const escaped = path.replace(/[\\*?[\]]/g, "\\$&");
    // Git 2.23 otherwise treats the plain prefix as the gitlink itself.
    const prefix = escaped.startsWith("\\") ? escaped : `\\${escaped}`;
    return [literalPathspec(path), `:(top,glob,exclude)${prefix}/**`];
  });
}
export function commandLine(bytes: Buffer) {
  return utf8(bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes);
}
export class NulRecords {
  private partial = Buffer.alloc(0);
  constructor(private each: (record: Buffer) => void) {}
  data = (chunk: Buffer) => {
    const bytes = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let start = 0,
      end: number;
    while ((end = bytes.indexOf(0, start)) !== -1) {
      if (end - start > agentLimits.resultBytes)
        throw new AppError("limit_exceeded", "A Git record exceeds the size limit");
      this.each(bytes.subarray(start, end));
      start = end + 1;
    }
    this.partial = Buffer.from(bytes.subarray(start));
    if (this.partial.length > agentLimits.resultBytes)
      throw new AppError("limit_exceeded", "A Git record exceeds the size limit");
  };
  end() {
    if (this.partial.length) throw new AppError("io_error", "Git record is incomplete");
  }
}
