import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { asError, type TaskOutput, type TaskRun } from "@kiteline/shared/protocol";

type OutputBytes = Pick<TaskRun["output"], "stdoutBytes" | "stderrBytes">;
const outputSuffix = /\.(stdout|stderr)$/;

export class TaskOutputs {
  private readonly sizes = new Map<string, number>();
  private readonly residuals = new Map<string, string | undefined>();
  private usedBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly runLimit: number,
    private readonly totalLimit: number,
  ) {}

  private path(id: string, stream: "stdout" | "stderr") {
    return join(this.directory, `${id}.${stream}`);
  }

  async load(files: string[]) {
    const outputs = new Map<string, OutputBytes>();
    for (const file of files) {
      const match = outputSuffix.exec(file);
      if (!match) continue;
      const path = join(this.directory, file);
      try {
        if (!(await lstat(path)).isFile()) throw new Error("Output is not a regular file");
        const output = await open(path, "r");
        try {
          const id = file.replace(outputSuffix, "");
          const bytes = outputs.get(id) ?? { stdoutBytes: 0, stderrBytes: 0 };
          const key = match[1] === "stdout" ? "stdoutBytes" : "stderrBytes";
          bytes[key] = (await output.stat()).size;
          outputs.set(id, bytes);
        } finally {
          await output.close();
        }
      } catch (error) {
        throw new Error(`${path}: ${asError(error).message}`, { cause: error });
      }
    }
    for (const [id, bytes] of outputs) this.adjustBytes(id, bytes.stdoutBytes + bytes.stderrBytes);
    return outputs;
  }

  bytes(id: string) {
    return this.sizes.get(id) ?? 0;
  }

  get totalBytes() {
    return this.usedBytes;
  }

  private adjustBytes(id: string, delta: number) {
    this.usedBytes += delta;
    const size = this.bytes(id) + delta;
    if (size) this.sizes.set(id, size);
    else this.sizes.delete(id);
  }

  forRun(id: string) {
    return {
      path: (stream: "stdout" | "stderr") => this.path(id, stream),
      reserve: (wanted: number) => {
        const bytes = Math.min(
          wanted,
          Math.max(0, this.runLimit - this.bytes(id)),
          Math.max(0, this.totalLimit - this.usedBytes),
        );
        this.adjustBytes(id, bytes);
        return bytes;
      },
      release: (unwritten: number) => this.adjustBytes(id, -unwritten),
    };
  }

  markResidual(id: string) {
    if (!this.residuals.has(id)) this.residuals.set(id, undefined);
  }

  hasResidualId(id: string) {
    const key = id.toLowerCase();
    return [...this.residuals.keys()].some((existing) => existing.toLowerCase() === key);
  }

  diagnostics() {
    return [...this.residuals].flatMap(([id, error]) =>
      error === undefined ? [] : [`${id} output cleanup failed: ${error}`],
    );
  }

  async remove(id: string) {
    this.markResidual(id);
    try {
      for (const stream of ["stdout", "stderr"] as const) {
        const path = this.path(id, stream);
        const bytes = await lstat(path).then(
          (info) => {
            if (!info.isFile()) throw new Error(`Task output is not a regular file: ${path}`);
            return info.size;
          },
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return 0;
            throw error;
          },
        );
        await rm(path, { force: true });
        this.adjustBytes(id, -Math.min(bytes, this.bytes(id)));
      }
      this.adjustBytes(id, -this.bytes(id));
      this.residuals.delete(id);
    } catch (error) {
      this.residuals.set(id, asError(error).message);
      throw error;
    }
  }

  async removeResiduals() {
    for (const id of this.residuals.keys()) {
      try {
        await this.remove(id);
      } catch (error) {
        console.error("Scheduled task retention:", asError(error).message);
      }
    }
  }

  async read({
    id,
    stream,
    offset,
    limit,
    finished,
    signal,
  }: {
    id: string;
    stream: "stdout" | "stderr";
    offset: number;
    limit: number;
    finished: boolean;
    signal: AbortSignal;
  }): Promise<Omit<TaskOutput, "truncated">> {
    let file;
    try {
      file = await open(this.path(id, stream), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { text: "", offset: 0, nextOffset: 0, storedBytes: 0, finished };
    }
    try {
      const size = (await file.stat()).size;
      if (offset > size) offset = 0;
      const bytes = Buffer.alloc(Math.min(limit, size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      signal.throwIfAborted();
      const flush = finished && offset + bytesRead === size;
      let completeBytes = bytesRead;
      if (!flush && bytesRead) {
        let sequenceStart = bytesRead - 1;
        while (
          sequenceStart > 0 &&
          bytesRead - sequenceStart < 4 &&
          (bytes[sequenceStart]! & 0xc0) === 0x80
        )
          sequenceStart--;
        const leadByte = bytes[sequenceStart]!;
        let sequenceBytes = 1;
        if (leadByte >= 0xc2 && leadByte <= 0xdf) sequenceBytes = 2;
        else if (leadByte >= 0xe0 && leadByte <= 0xef) sequenceBytes = 3;
        else if (leadByte >= 0xf0 && leadByte <= 0xf4) sequenceBytes = 4;
        if (bytesRead - sequenceStart < sequenceBytes) completeBytes = sequenceStart;
      }
      return {
        text: bytes.subarray(0, completeBytes).toString("utf8"),
        offset,
        nextOffset: offset + completeBytes,
        storedBytes: size,
        finished,
      };
    } finally {
      await file.close();
    }
  }
}
