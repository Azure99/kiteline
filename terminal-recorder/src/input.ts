import { AppError, limits, asError } from "@kiteline/shared/protocol";
import { normalizePaste } from "@kiteline/shared/terminal";
import { tmux } from "@kiteline/shared/terminal/node";
import type { RecorderConfig, TerminalFrame } from "@kiteline/shared/ipc";
import type { Control } from "./control.js";
import type { Model } from "./model.js";

type Input =
  | { type: "input" | "paste"; attachmentId: string; data: Buffer }
  | { type: "resize"; attachmentId: string; cols: number; rows: number }
  | {
      type: "redraw";
      attachmentId: undefined;
      resolve: () => void;
      reject: (error: unknown) => void;
    };
const cost = (item: Input) => ("data" in item ? item.data.length : 32);
export class InputQueue {
  private queue: Input[] = [];
  private bytes = 0;
  private running = false;
  private closed = false;
  constructor(
    private control: Control,
    private model: Model,
    private config: RecorderConfig,
    private report: (id: string, frame: TerminalFrame) => void,
    private redrawTask: () => Promise<void>,
  ) {}
  input(attachmentId: string, data: Buffer, paste = false) {
    if (this.closed || !data.length) return;
    if (this.bytes + data.length > this.config.terminalInputBytes) {
      this.reject(
        attachmentId,
        new AppError("limit_exceeded", "Terminal input exceeds the capacity limit"),
        "failed",
      );
      return;
    }
    const last = this.queue.at(-1);
    if (!paste && last?.type === "input" && last.attachmentId === attachmentId)
      last.data = Buffer.concat([last.data, data]);
    else this.queue.push({ type: paste ? "paste" : "input", attachmentId, data });
    this.bytes += data.length;
    void this.run();
  }
  paste(attachmentId: string, text: string) {
    this.input(attachmentId, Buffer.from(normalizePaste(text)), true);
  }
  resize(attachmentId: string, cols: number, rows: number) {
    if (this.closed) return;
    if (
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > limits.terminalMaxCols ||
      rows > limits.terminalMaxRows
    ) {
      this.reject(
        attachmentId,
        new AppError("invalid_argument", "Invalid terminal dimensions"),
        "failed",
      );
      return;
    }
    const last = this.queue.at(-1);
    if (last?.type === "resize" && last.attachmentId === attachmentId) {
      last.cols = cols;
      last.rows = rows;
    } else {
      if (this.bytes + 32 > this.config.terminalInputBytes) {
        this.reject(attachmentId, new AppError("busy", "Terminal input queue is full"), "failed");
        return;
      }
      this.queue.push({ type: "resize", attachmentId, cols, rows });
      this.bytes += 32;
    }
    void this.run();
  }
  detach(id: string) {
    this.queue = this.queue.filter((item) => {
      if (item.attachmentId !== id) return true;
      this.bytes -= cost(item);
      return false;
    });
  }
  redraw() {
    if (this.closed)
      return Promise.reject(new AppError("recording_unavailable", "Recording interrupted"));
    if (this.bytes + 32 > this.config.terminalInputBytes)
      return Promise.reject(new AppError("busy", "Terminal input queue is full"));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ type: "redraw", attachmentId: undefined, resolve, reject });
      this.bytes += 32;
      void this.run();
    });
  }
  private reject(id: string, error: unknown, outcome: "failed" | "unknown") {
    this.report(id, { type: "input.error", ...asError(error), outcome });
  }
  private async run() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && this.queue.length) {
        const item = this.queue.shift()!;
        try {
          if (item.type === "redraw") {
            await this.redrawTask();
            item.resolve();
          } else if (item.type === "resize") {
            await this.control.resize(item.cols, item.rows);
            await this.model.waitForSize(item.cols, item.rows, this.config.channelPairTimeout);
          } else {
            const identity = this.control.identity;
            if (!identity) throw new AppError("busy", "Terminal creation is not complete");
            await tmux(
              identity.socket,
              [
                "load-buffer",
                "-b",
                "kiteline-web-input",
                "-",
                ";",
                "paste-buffer",
                "-r",
                "-d",
                ...(item.type === "paste" ? ["-p"] : []),
                "-b",
                "kiteline-web-input",
                "-t",
                identity.paneId,
              ],
              item.data,
              AbortSignal.timeout(this.config.channelPairTimeout),
            );
          }
        } catch (error) {
          if (item.type === "redraw") item.reject(error);
          else this.reject(item.attachmentId, error, "unknown");
          const socket = this.control.identity?.socket;
          if (socket && "data" in item)
            await tmux(
              socket,
              ["delete-buffer", "-b", "kiteline-web-input"],
              undefined,
              AbortSignal.timeout(this.config.channelPairTimeout),
            ).catch(() => {});
        } finally {
          this.bytes -= cost(item);
        }
      }
    } finally {
      this.running = false;
    }
  }
  close() {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      this.bytes -= cost(item);
      if (item.type === "redraw") item.reject(new AppError("cancelled", "Terminal closed"));
    }
  }
}
