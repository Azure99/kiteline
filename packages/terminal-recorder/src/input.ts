import type { TerminalOperation, TerminalPosition, InputPosition } from "@kiteline/shared/protocol";
import { AppError, OperationError, asError, limits } from "@kiteline/shared/protocol";
import { normalizePaste } from "@kiteline/shared/terminal";
import { tmux } from "@kiteline/shared/terminal/node";
import type { RecorderConfig, TerminalFrame } from "@kiteline/shared/protocol/ipc";
import type { Control } from "./control.js";
import type { Model } from "./model.js";

export const webInputBuffer = "kiteline-web-input";
export function isMissingInputBuffer(error: unknown) {
  return (
    error instanceof AppError &&
    error.code === "command_failed" &&
    error.message === `unknown buffer: ${webInputBuffer}`
  );
}

interface Operation {
  type: "operation";
  attachmentId: undefined;
  bytes: number;
  run: () => Promise<void>;
  fail: (error: unknown) => void;
}
type Input =
  | Operation
  | { type: "input" | "paste"; attachmentId: string; data: Buffer }
  | { type: "resize"; attachmentId: string; cols: number; rows: number }
  | {
      type: "redraw";
      attachmentId: undefined;
      resolve: () => void;
      reject: (error: unknown) => void;
    };
const inputCommandBytes = 32;
const cost = (item: Input) =>
  item.type === "operation" ? item.bytes : "data" in item ? item.data.length : inputCommandBytes;
export class InputQueue {
  private queue: Input[] = [];
  private bytes = 0;
  private running?: Promise<void>;
  private abort = new AbortController();
  private get closed() {
    return this.abort.signal.aborted;
  }
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
    this.model.admitInput();
    void this.run();
  }
  paste(attachmentId: string, text: string) {
    this.input(attachmentId, Buffer.from(normalizePaste(text)), true);
  }
  resize(attachmentId: string, cols: number, rows: number) {
    if (this.closed) return;
    const last = this.queue.at(-1);
    if (last?.type === "resize" && last.attachmentId === attachmentId) {
      last.cols = cols;
      last.rows = rows;
    } else {
      if (this.bytes + inputCommandBytes > this.config.terminalInputBytes) {
        this.reject(attachmentId, new AppError("busy", "Terminal input queue is full"), "failed");
        return;
      }
      this.queue.push({ type: "resize", attachmentId, cols, rows });
      this.bytes += inputCommandBytes;
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
    if (this.bytes + inputCommandBytes > this.config.terminalInputBytes)
      return Promise.reject(new AppError("busy", "Terminal input queue is full"));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ type: "redraw", attachmentId: undefined, resolve, reject });
      this.bytes += inputCommandBytes;
      void this.run();
    });
  }
  private async inject(data: Buffer, paste: boolean, signal: AbortSignal) {
    const identity = this.control.identity;
    if (!identity) throw new AppError("busy", "Terminal creation is not complete");
    try {
      // load-buffer needs its own stdin; the persistent control client cannot supply it.
      await tmux(
        identity.socket,
        [
          "load-buffer",
          "-b",
          webInputBuffer,
          "-",
          ";",
          "paste-buffer",
          "-r",
          "-d",
          ...(paste ? ["-p"] : []),
          "-b",
          webInputBuffer,
          "-t",
          identity.paneId,
        ],
        data,
        AbortSignal.any([signal, AbortSignal.timeout(limits.interactionTimeout)]),
      );
    } catch (error) {
      await tmux(
        identity.socket,
        ["delete-buffer", "-b", webInputBuffer],
        undefined,
        AbortSignal.timeout(limits.interactionTimeout),
      ).catch((cleanupError: unknown) => {
        if (!isMissingInputBuffer(cleanupError))
          console.error(
            `Could not delete input buffer ${webInputBuffer} on ${identity.socket}: ${asError(cleanupError).message}`,
          );
      });
      throw error;
    }
  }
  operation(operation: TerminalOperation) {
    if (this.closed)
      return Promise.reject(new AppError("recording_unavailable", "Recording interrupted"));
    const input = operation.type === "session.send" ? operation.input : undefined;
    const data =
      input && input.type !== "key"
        ? Buffer.from(input.type === "paste" ? normalizePaste(input.text) : input.text)
        : undefined;
    const bytes = data
      ? data.length + (input?.type !== "key" && input?.enter ? 1 : 0)
      : inputCommandBytes;
    if (this.bytes + bytes > this.config.terminalInputBytes)
      return Promise.reject(
        new AppError("limit_exceeded", "Terminal input exceeds the capacity limit"),
      );
    return new Promise<
      { before: TerminalPosition; input: InputPosition } | { cols: number; rows: number }
    >((resolve, reject) => {
      if (operation.type === "session.send") this.model.admitInput(operation.ifInput);
      let started = false;
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, this.abort.signal]);
      const fail = (cause: unknown) => {
        clearTimeout(timer);
        const error = asError(cause);
        reject(new OperationError(error.code, error.message, started ? "unknown" : "failed"));
      };
      const assertActive = () => {
        signal.throwIfAborted();
        if (Date.now() >= operation.deadline)
          throw new AppError("timeout", "Terminal operation deadline expired");
      };
      const item: Operation = {
        type: "operation",
        attachmentId: undefined,
        bytes,
        fail,
        run: async () => {
          try {
            assertActive();
            const before = await this.model.ordered(() => this.model.position());
            assertActive();
            started = true;
            if (operation.type === "session.resize") {
              await this.control.resize(operation.cols, operation.rows, signal);
              assertActive();
              await this.model.waitForSize(
                operation.cols,
                operation.rows,
                this.control.schedule,
                signal,
              );
              resolve({ cols: operation.cols, rows: operation.rows });
            } else {
              if (input!.type === "key") {
                const key = input!.key;
                const keys = {
                  Enter: "\r",
                  Escape: "\x1b",
                  CtrlC: "\x03",
                  Tab: "\t",
                  PageUp: "\x1b[5~",
                  PageDown: "\x1b[6~",
                };
                const text =
                  key === "Up" || key === "Down"
                    ? `\x1b${this.model.terminal.modes.applicationCursorKeysMode ? "O" : "["}${key === "Up" ? "A" : "B"}`
                    : keys[key];
                await this.inject(Buffer.from(text), false, signal);
              } else {
                if (data!.length) await this.inject(data!, input!.type === "paste", signal);
                if (input!.enter) {
                  assertActive();
                  await this.inject(Buffer.from("\r"), false, signal);
                }
              }
              resolve({ before, input: this.model.inputState() });
            }
          } finally {
            clearTimeout(timer);
          }
        },
      };
      const timer = setTimeout(
        () => {
          const index = this.queue.indexOf(item);
          if (index !== -1) {
            this.queue.splice(index, 1);
            this.bytes -= bytes;
          }
          const error = new AppError("timeout", "Terminal operation deadline expired");
          abort.abort(error);
          fail(error);
        },
        Math.max(0, operation.deadline - Date.now()),
      );
      this.queue.push(item);
      this.bytes += bytes;
      void this.run();
    });
  }
  private reject(id: string, error: unknown, outcome: "failed" | "unknown") {
    this.report(id, { type: "input.error", ...asError(error), outcome });
  }
  private run() {
    if (this.running || this.closed) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async drain() {
    while (!this.closed && this.queue.length) {
      await this.control.waitReadable();
      if (this.closed || !this.queue.length) break;
      const item = this.queue.shift()!;
      try {
        if (item.type === "operation") await item.run();
        else if (item.type === "redraw") {
          await this.redrawTask();
          item.resolve();
        } else if (item.type === "resize") {
          await this.control.resize(item.cols, item.rows);
          await this.model.waitForSize(
            item.cols,
            item.rows,
            this.control.schedule,
            this.control.signal,
          );
        } else {
          await this.inject(item.data, item.type === "paste", this.abort.signal);
        }
      } catch (error) {
        if (item.type === "operation") item.fail(error);
        else if (item.type === "redraw") item.reject(error);
        else this.reject(item.attachmentId, error, "unknown");
      } finally {
        this.bytes -= cost(item);
      }
    }
  }
  close() {
    this.abort.abort(new AppError("cancelled", "Terminal closed"));
    for (const item of this.queue.splice(0)) {
      this.bytes -= cost(item);
      if (item.type === "operation") item.fail(new AppError("cancelled", "Terminal closed"));
      else if (item.type === "redraw") item.reject(new AppError("cancelled", "Terminal closed"));
    }
    return this.running ?? Promise.resolve();
  }
}
