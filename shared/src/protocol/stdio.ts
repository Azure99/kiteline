import type { Readable, Writable } from "node:stream";
import { AppError, limits } from "./index.js";

export function readLines(
  stream: Readable,
  onLine: (line: Buffer) => void,
  onError: (error: Error) => void,
) {
  let partial = Buffer.alloc(0);
  const data = (chunk: Buffer) => {
    try {
      const buffer = partial.length ? Buffer.concat([partial, chunk]) : chunk;
      let offset = 0;
      let end: number;
      while ((end = buffer.indexOf(10, offset)) !== -1) {
        if (end - offset > limits.controlMessageBytes)
          throw new AppError("limit_exceeded", "Control line exceeds the size limit");
        onLine(buffer.subarray(offset, end));
        offset = end + 1;
      }
      partial = Buffer.from(buffer.subarray(offset));
      if (partial.length > limits.controlMessageBytes)
        throw new AppError("limit_exceeded", "Control line exceeds the size limit");
    } catch (error) {
      stream.off("data", data);
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  stream.on("data", data);
  stream.on("error", onError);
  return () => {
    stream.off("data", data);
    stream.off("error", onError);
    partial = Buffer.alloc(0);
  };
}

export class JsonWriter {
  private queue: { owner: string; data: string; bytes: number }[] = [];
  private bytes = new Map<string, number>();
  private blocked = false;
  private closed = false;
  constructor(private stream: Writable) {
    stream.on("drain", this.drain);
  }
  send(message: unknown, owner = "") {
    const data = JSON.stringify(message) + "\n";
    const bytes = Buffer.byteLength(data);
    if (bytes > limits.controlMessageBytes)
      throw new AppError("limit_exceeded", "IPC message exceeds the size limit");
    if (this.closed || this.stream.destroyed) return false;
    const pending = this.bytes.get(owner) ?? 0;
    if (pending + bytes > limits.terminalPendingBytes) return false;
    this.queue.push({ owner, data, bytes });
    this.bytes.set(owner, pending + bytes);
    this.flush();
    return true;
  }
  discard(owner: string) {
    this.queue = this.queue.filter((item) => item.owner !== owner);
    this.bytes.delete(owner);
  }
  private drain = () => {
    this.blocked = false;
    this.flush();
  };
  private flush() {
    while (!this.closed && !this.blocked && this.queue.length) {
      const item = this.queue.shift()!;
      const remaining = this.bytes.get(item.owner)! - item.bytes;
      if (remaining) this.bytes.set(item.owner, remaining);
      else this.bytes.delete(item.owner);
      this.blocked = !this.stream.write(item.data);
    }
  }
  close() {
    this.closed = true;
    this.stream.off("drain", this.drain);
    this.queue = [];
    this.bytes.clear();
  }
}
