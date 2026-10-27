import type {
  TerminalOperation,
  TerminalPosition,
  InputPosition,
  SessionInput,
} from "@kiteline/shared/protocol";
import { AppError, OperationError, asError, limits } from "@kiteline/shared/protocol";
import { setTimeout as delay } from "node:timers/promises";
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

interface BytesRequest {
  type: "bytes";
  data: Buffer;
  paste: boolean;
  enter: boolean;
}
interface KeyRequest {
  type: "key";
  key: Extract<SessionInput, { type: "key" }>["key"];
}
interface ResizeRequest {
  type: "resize";
  cols: number;
  rows: number;
}
type Request = BytesRequest | KeyRequest | ResizeRequest;
interface WebInput {
  kind: "web";
  attachmentId: string;
  request: BytesRequest | ResizeRequest;
}
type RpcResult =
  | { before: TerminalPosition; input: InputPosition }
  | { cols: number; rows: number };
interface RpcCompletion {
  deadline: number;
  started: boolean;
  abort: AbortController;
  timer?: NodeJS.Timeout;
  resolve: (result: RpcResult) => void;
  reject: (error: unknown) => void;
}
interface RpcInput {
  kind: "rpc";
  request: Request;
  completion: RpcCompletion;
}
interface RedrawInput {
  kind: "redraw";
  resolve: () => void;
  reject: (error: unknown) => void;
}
type Input = WebInput | RpcInput | RedrawInput;
const inputCommandBytes = 32;
const redrawDwellMs = 80;
const requestCost = (request: Request) =>
  request.type === "bytes" ? request.data.length + (request.enter ? 1 : 0) : inputCommandBytes;
const cost = (item: Input) =>
  item.kind === "redraw" ? inputCommandBytes : requestCost(item.request);
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
    if (
      !paste &&
      last?.kind === "web" &&
      last.request.type === "bytes" &&
      !last.request.paste &&
      last.attachmentId === attachmentId
    )
      last.request.data = Buffer.concat([last.request.data, data]);
    else
      this.queue.push({
        kind: "web",
        attachmentId,
        request: { type: "bytes", data, paste, enter: false },
      });
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
    if (
      last?.kind === "web" &&
      last.request.type === "resize" &&
      last.attachmentId === attachmentId
    ) {
      last.request.cols = cols;
      last.request.rows = rows;
    } else {
      if (this.bytes + inputCommandBytes > this.config.terminalInputBytes) {
        this.reject(attachmentId, new AppError("busy", "Terminal input queue is full"), "failed");
        return;
      }
      this.queue.push({ kind: "web", attachmentId, request: { type: "resize", cols, rows } });
      this.bytes += inputCommandBytes;
    }
    void this.run();
  }
  detach(id: string) {
    this.queue = this.queue.filter((item) => {
      if (item.kind !== "web" || item.attachmentId !== id) return true;
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
      this.queue.push({ kind: "redraw", resolve, reject });
      this.bytes += inputCommandBytes;
      void this.run();
    });
  }
  private async executeRedraw() {
    const { cols, rows } = await this.model.ordered(() => ({
      cols: this.model.terminal.cols,
      rows: this.model.terminal.rows,
    }));
    try {
      await this.control.resize(cols, rows + 1);
      await this.model.waitForSize(cols, rows + 1, this.control.schedule, this.control.signal);
      await delay(redrawDwellMs);
    } finally {
      await this.control.resize(cols, rows);
      await this.model.waitForSize(cols, rows, this.control.schedule, this.control.signal);
    }
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
    let request: Request;
    if (operation.type === "session.resize") {
      request = { type: "resize", cols: operation.cols, rows: operation.rows };
    } else {
      const input = operation.input;
      if (input.type === "key") {
        request = { type: "key", key: input.key };
      } else {
        const paste = input.type === "paste";
        request = {
          type: "bytes",
          data: Buffer.from(paste ? normalizePaste(input.text) : input.text),
          paste,
          enter: input.enter === true,
        };
      }
    }
    const bytes = requestCost(request);
    if (this.bytes + bytes > this.config.terminalInputBytes)
      return Promise.reject(
        new AppError("limit_exceeded", "Terminal input exceeds the capacity limit"),
      );
    return new Promise<RpcResult>((resolve, reject) => {
      if (operation.type === "session.send") this.model.admitInput(operation.ifInput);
      const item: RpcInput = {
        kind: "rpc",
        request,
        completion: {
          deadline: operation.deadline,
          started: false,
          abort: new AbortController(),
          resolve,
          reject,
        },
      };
      item.completion.timer = setTimeout(
        () => this.expireRpc(item),
        Math.max(0, operation.deadline - Date.now()),
      );
      this.queue.push(item);
      this.bytes += bytes;
      void this.run();
    });
  }
  private assertRpcActive(completion: RpcCompletion, signal: AbortSignal) {
    signal.throwIfAborted();
    if (Date.now() >= completion.deadline)
      throw new AppError("timeout", "Terminal operation deadline expired");
  }
  private async executeRpc(item: RpcInput) {
    const { completion, request } = item;
    const signal = AbortSignal.any([completion.abort.signal, this.abort.signal]);
    try {
      this.assertRpcActive(completion, signal);
      const before = await this.model.ordered(() => this.model.position());
      this.assertRpcActive(completion, signal);
      completion.started = true;
      await this.executeRequest(item, signal);
      completion.resolve(
        request.type === "resize"
          ? { cols: request.cols, rows: request.rows }
          : { before, input: this.model.inputState() },
      );
    } finally {
      clearTimeout(completion.timer);
    }
  }
  private async executeRequest(item: WebInput | RpcInput, signal: AbortSignal) {
    const { request } = item;
    if (request.type === "resize") {
      // Web commands and size observation retain the Control lifetime; RPC adds its deadline.
      await this.control.resize(
        request.cols,
        request.rows,
        item.kind === "rpc" ? signal : undefined,
      );
      if (item.kind === "rpc") this.assertRpcActive(item.completion, signal);
      await this.model.waitForSize(
        request.cols,
        request.rows,
        this.control.schedule,
        item.kind === "rpc" ? signal : this.control.signal,
      );
    } else if (request.type === "key") {
      const key = request.key;
      const keys = {
        Enter: "\r",
        Escape: "\x1b",
        CtrlC: "\x03",
        Tab: "\t",
        PageUp: "\x1b[5~",
        PageDown: "\x1b[6~",
      };
      let text: string;
      if (key === "Up" || key === "Down") {
        const prefix = this.model.terminal.modes.applicationCursorKeysMode ? "O" : "[";
        const direction = key === "Up" ? "A" : "B";
        text = `\x1b${prefix}${direction}`;
      } else {
        text = keys[key];
      }
      await this.inject(Buffer.from(text), false, signal);
    } else {
      if (request.data.length) await this.inject(request.data, request.paste, signal);
      if (request.enter) {
        if (item.kind === "rpc") this.assertRpcActive(item.completion, signal);
        await this.inject(Buffer.from("\r"), false, signal);
      }
    }
  }
  private expireRpc(item: RpcInput) {
    const index = this.queue.indexOf(item);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.bytes -= cost(item);
    }
    // A reply can expire while drain still awaits the actual tmux client and its cleanup.
    const error = new AppError("timeout", "Terminal operation deadline expired");
    item.completion.abort.abort(error);
    this.failRpc(item, error);
  }
  private failRpc(item: RpcInput, cause: unknown) {
    const { completion } = item;
    clearTimeout(completion.timer);
    const error = asError(cause);
    completion.reject(
      new OperationError(error.code, error.message, completion.started ? "unknown" : "failed"),
    );
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
        if (item.kind === "rpc") await this.executeRpc(item);
        else if (item.kind === "redraw") {
          await this.executeRedraw();
          item.resolve();
        } else await this.executeRequest(item, this.abort.signal);
      } catch (error) {
        if (item.kind === "rpc") this.failRpc(item, error);
        else if (item.kind === "redraw") item.reject(error);
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
      if (item.kind === "rpc") this.failRpc(item, new AppError("cancelled", "Terminal closed"));
      else if (item.kind === "redraw") item.reject(new AppError("cancelled", "Terminal closed"));
    }
    return this.running ?? Promise.resolve();
  }
}
