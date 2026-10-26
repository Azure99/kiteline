import { randomUUID } from "node:crypto";
import type { IBufferLine } from "@xterm/headless";
import type {
  ScreenOptions,
  ScreenLine,
  TerminalScreen,
  ScreenWait,
  ScreenWaitResult,
  SnapshotOptions,
  SnapshotResult,
  InputPosition,
  CellStyle,
  TerminalNotice,
} from "@kiteline/shared/protocol";
import { StringDecoder } from "node:string_decoder";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { AppError, limits } from "@kiteline/shared/protocol";
import {
  atGround,
  mouseEncodingVT,
  adaptTerminalProfile,
  terminalOptions,
  initializeTerminalUnicode,
} from "@kiteline/shared/terminal";
import type { TerminalEvent } from "@kiteline/shared/protocol/ipc";
import { terminalNotice } from "./notice.js";

const { Terminal } = headless;
const { SerializeAddon } = serialize;

// SerializeAddon omits the window title, so a new display would lose it until the program
// sends another one. Control characters cannot appear inside the replayed OSC 2.
function titleVT(title: string) {
  // eslint-disable-next-line no-control-regex
  const text = title.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return text ? `\x1b]2;${text}\x07` : "";
}

export interface Snapshot {
  data: Buffer;
  cols: number;
  rows: number;
  historyLimited: boolean;
  tail: TerminalEvent[];
}
export function eventCost(event: TerminalEvent) {
  return event.type === "output" ? Buffer.byteLength(event.data) : 32;
}
export class Model {
  readonly terminal: InstanceType<typeof Terminal>;
  private epoch = randomUUID();
  private seq = 0;
  private inputSeq = 0;
  private observers = new AbortController();
  private serializer = new SerializeAddon();
  private decoder = new StringDecoder("utf8");
  private queue: Promise<unknown> = Promise.resolve();
  private pendingOutput?: { parts: string[]; bytes: number };
  private pendingBytes = 0;
  private checkpoint?: Omit<Snapshot, "tail">;
  private title = "";
  private tail: TerminalEvent[] = [];
  private tailBytes = 0;
  private snapshotError?: Error;
  private get stopped() {
    return this.observers.signal.aborted;
  }
  private listeners = new Set<(event: TerminalEvent) => void>();
  private waiting = new Set<() => void>();
  constructor(
    cols: number,
    rows: number,
    readonly historyLines: number,
    private fault: (error: Error) => void,
    private changed: () => void,
    notice?: (notice: TerminalNotice) => void,
  ) {
    this.terminal = new Terminal({ ...terminalOptions(historyLines), cols, rows });
    initializeTerminalUnicode(this.terminal);
    adaptTerminalProfile(this.terminal);
    this.terminal.loadAddon(this.serializer);
    this.terminal.onTitleChange((title) => {
      this.title = title;
    });
    for (const code of [9, 777, 7501])
      this.terminal.parser.registerOscHandler(code, (body) => {
        const report = terminalNotice(code, body);
        if (report) notice?.(report);
        return true;
      });
    this.rotate();
  }
  get backlog() {
    return this.pendingBytes;
  }
  ordered<T>(action: () => T | Promise<T>): Promise<T> {
    // Only adjacent output that has not started parsing can share a batch.
    this.pendingOutput = undefined;
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  output(raw: Buffer) {
    if (this.stopped) return;
    const data = this.decoder.write(raw);
    if (!data) return;
    const bytes = Buffer.byteLength(data);
    this.pendingBytes += bytes;
    this.changed();
    if (this.pendingBytes > modelLimits.terminalModelPendingBytes) {
      this.fault(
        new AppError("limit_exceeded", "Terminal recording parser backlog exceeds the limit"),
      );
      return;
    }
    if (this.pendingOutput && this.pendingOutput.bytes + bytes <= limits.dataChunkBytes) {
      this.pendingOutput.parts.push(data);
      this.pendingOutput.bytes += bytes;
      return;
    }
    const batch = { parts: [data], bytes };
    void this.ordered(async () => {
      if (this.pendingOutput === batch) this.pendingOutput = undefined;
      try {
        if (this.stopped) return;
        const data = batch.parts.join("");
        await new Promise<void>((resolve) => this.terminal.write(data, resolve));
        this.record({ type: "output", data });
      } finally {
        this.pendingBytes -= batch.bytes;
        this.changed();
      }
    }).catch((error: Error) => this.fault(error));
    this.pendingOutput = batch;
  }
  resize(cols: number, rows: number) {
    const event: TerminalEvent = { type: "resize", cols, rows };
    const bytes = eventCost(event);
    this.pendingBytes += bytes;
    this.changed();
    void this.ordered(() => {
      try {
        if (this.stopped || (this.terminal.cols === cols && this.terminal.rows === rows)) return;
        this.terminal.resize(cols, rows);
        this.record(event);
      } finally {
        this.pendingBytes -= bytes;
        this.changed();
      }
    }).catch((error: Error) => this.fault(error));
  }
  waitForSize(
    cols: number,
    rows: number,
    schedule: (fail: () => void) => () => void,
    signal: AbortSignal,
  ) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        cancel();
        this.listeners.delete(check);
        signal.removeEventListener("abort", abort);
      };
      const check = () => {
        if (this.terminal.cols === cols && this.terminal.rows === rows) {
          cleanup();
          resolve();
        }
      };
      const cancel = schedule(() => {
        cleanup();
        reject(
          new AppError(
            "timeout",
            "Actual terminal dimensions were not received; reopen the display and try again",
          ),
        );
      });
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.listeners.add(check);
      void this.ordered(check);
    });
  }
  async checkpointNow() {
    await this.ordered(() => {
      if (this.stopped) throw new AppError("recording_unavailable", "Recording interrupted");
      if (atGround(this.terminal)) this.rotate();
    });
  }
  private serialize(screen = false): Omit<Snapshot, "tail"> {
    let scrollback = screen ? 0 : this.terminal.buffer.normal.baseY;
    const original = this.terminal.buffer.normal.baseY;
    while (true) {
      const data = Buffer.from(
        this.serializer.serialize({ scrollback }) +
          mouseEncodingVT(this.terminal) +
          titleVT(this.title),
      );
      if (data.length <= limits.terminalSnapshotBytes)
        return {
          data,
          cols: this.terminal.cols,
          rows: this.terminal.rows,
          historyLimited: scrollback < original,
        };
      if (scrollback === 0)
        throw new AppError(
          "limit_exceeded",
          "Current terminal screen exceeds the recovery size limit",
        );
      scrollback = Math.floor(scrollback / 2);
    }
  }
  private rotate() {
    try {
      this.checkpoint = this.serialize();
      this.tail = [];
      this.tailBytes = 0;
      this.snapshotError = undefined;
    } catch (error) {
      this.snapshotError = error as Error;
    }
  }
  private record(event: TerminalEvent) {
    this.seq++;
    this.tailBytes += eventCost(event);
    if (this.checkpoint) this.tail.push(event);
    if (
      (this.tailBytes >= modelLimits.terminalCheckpointIntervalBytes || !this.checkpoint) &&
      atGround(this.terminal)
    )
      this.rotate();
    if (this.tailBytes > modelLimits.terminalRecoveryTailBytes) {
      this.checkpoint = undefined;
      this.tail = [];
    }
    for (const listener of this.listeners) listener(event);
    for (const resume of this.waiting) resume();
    this.waiting.clear();
  }
  async attach(
    history: "retained" | "screen",
    timeout: number,
    begin: (snapshot: Snapshot) => void,
    live: (event: TerminalEvent) => void,
    signal: AbortSignal,
  ) {
    const deadline = Date.now() + timeout;
    while (true) {
      signal.throwIfAborted();
      const attached = await this.ordered(() => {
        if (this.stopped) throw new AppError("recording_unavailable", "Recording interrupted");
        let snapshot: Snapshot | undefined;
        if (history === "screen") {
          if (atGround(this.terminal)) snapshot = { ...this.serialize(true), tail: [] };
        } else {
          if (atGround(this.terminal) && (!this.checkpoint || this.tail.length > 0)) this.rotate();
          if (this.checkpoint) snapshot = { ...this.checkpoint, tail: this.tail.slice() };
          else if (this.snapshotError && atGround(this.terminal)) throw this.snapshotError;
        }
        if (!snapshot) return false;
        signal.throwIfAborted();
        begin(snapshot);
        this.listeners.add(live);
        return true;
      });
      if (attached) return () => this.listeners.delete(live);
      if (Date.now() >= deadline)
        throw new AppError("busy", "A complete recovery boundary is not yet available; try again");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.waiting.delete(finish);
          signal.removeEventListener("abort", abort);
        };
        const finish = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const timer = setTimeout(finish, Math.max(1, deadline - Date.now()));
        this.waiting.add(finish);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  position() {
    if (this.stopped) throw new AppError("recording_unavailable", "Recording interrupted");
    return { epoch: this.epoch, seq: this.seq };
  }
  admitInput(condition?: InputPosition) {
    if (condition && (condition.epoch !== this.epoch || condition.inputSeq !== this.inputSeq))
      throw new AppError("conflict", "Terminal input position has changed");
    this.inputSeq++;
  }
  inputState(): InputPosition {
    return {
      epoch: this.epoch,
      inputSeq: this.inputSeq,
    };
  }
  private screen(options: ScreenOptions, historyGap: boolean): TerminalScreen {
    const position = {
      ...this.position(),
      tail: options.tail ?? null,
      attrs: options.attrs ?? false,
    };
    const terminal = this.terminal;
    const active = terminal.buffer.active;
    let lineBytes = 0;
    const project = (line: IBufferLine): ScreenLine => {
      const result: ScreenLine = { text: line.translateToString(true), wrapped: line.isWrapped };
      if (options.attrs) {
        const runs: NonNullable<ScreenLine["attrs"]> = [];
        let cell = active.getNullCell();
        let previous = active.getNullCell();
        for (let x = 0; x < terminal.cols; x++) {
          line.getCell(x, cell);
          const last = runs.at(-1);
          if (last?.end === x && cell.attributesEquals(previous)) last.end++;
          else if (!cell.isAttributeDefault()) {
            const style: CellStyle = {};
            if (cell.isFgPalette()) style.fg = { palette: cell.getFgColor() };
            else if (cell.isFgRGB())
              style.fg = { rgb: `#${cell.getFgColor().toString(16).padStart(6, "0")}` };
            if (cell.isBgPalette()) style.bg = { palette: cell.getBgColor() };
            else if (cell.isBgRGB())
              style.bg = { rgb: `#${cell.getBgColor().toString(16).padStart(6, "0")}` };
            if (cell.isBold()) style.bold = true;
            if (cell.isDim()) style.dim = true;
            if (cell.isItalic()) style.italic = true;
            if (cell.isUnderline()) style.underline = true;
            if (cell.isInverse()) style.inverse = true;
            if (cell.isInvisible()) style.invisible = true;
            if (cell.isBlink()) style.blink = true;
            if (cell.isStrikethrough()) style.strikethrough = true;
            if (cell.isOverline()) style.overline = true;
            if (Object.keys(style).length) runs.push({ start: x, end: x + 1, ...style });
          }
          [cell, previous] = [previous, cell];
        }
        result.attrs = runs;
      }
      // Stop building a large tail before allocating a reply that IPC cannot carry.
      // This lower bound excludes the envelope, whose existing writer checks the full size.
      lineBytes += Buffer.byteLength(JSON.stringify(result));
      if (lineBytes > limits.controlMessageBytes)
        throw new AppError("limit_exceeded", "Terminal observation exceeds the size limit");
      return result;
    };
    const screen = Array.from({ length: terminal.rows }, (_, y) =>
      project(active.getLine(active.baseY + y)!),
    );
    const normal = terminal.buffer.normal;
    const omitted = Math.max(0, normal.baseY - (options.tail ?? 0));
    return {
      position,
      input: this.inputState(),
      cols: terminal.cols,
      rows: terminal.rows,
      active: active.type,
      cursor: { x: active.cursorX, y: active.cursorY, visible: terminal.modes.showCursor },
      screen,
      historyGap,
      synchronizedOutput: terminal.modes.synchronizedOutputMode,
      ...(options.tail === undefined
        ? {}
        : {
            tail: {
              buffer: "normal" as const,
              omitted,
              lines: Array.from({ length: normal.baseY - omitted }, (_, y) =>
                project(normal.getLine(omitted + y)!),
              ),
            },
          }),
    };
  }
  observe(options: SnapshotOptions, historyGap: boolean): Promise<SnapshotResult> {
    return this.ordered(() => {
      const position = {
        ...this.position(),
        tail: options.tail ?? null,
        attrs: options.attrs ?? false,
      };
      const condition = options.ifChanged;
      if (
        condition &&
        condition.epoch === position.epoch &&
        condition.seq === position.seq &&
        condition.tail === position.tail &&
        condition.attrs === position.attrs
      )
        return { reason: "unchanged", position, input: this.inputState() };
      return {
        ...this.screen(options, historyGap),
        reason: condition && condition.epoch !== position.epoch ? "reset" : "full",
      };
    });
  }
  wait(options: ScreenWait, historyGap: boolean, deadline: number) {
    return new Promise<ScreenWaitResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let quietAt = 0;
      let done = false;
      const cleanup = () => {
        done = true;
        clearTimeout(timer);
        this.listeners.delete(activity);
        this.observers.signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(this.observers.signal.reason);
      };
      const check = () => {
        if (done) return;
        try {
          const position = this.position();
          let reason: ScreenWaitResult["reason"] | undefined;
          if (options.mode === "change") {
            if (position.epoch !== options.after.epoch) reason = "reset";
            else if (position.seq > options.after.seq) reason = "changed";
          }
          if (options.mode === "quiet" && quietAt <= deadline && Date.now() >= quietAt)
            reason = "quiet";
          if (!reason && Date.now() >= deadline) reason = "timeout";
          if (reason) {
            cleanup();
            resolve({ reason, snapshot: this.screen(options, historyGap) });
            return;
          }
          clearTimeout(timer);
          timer = setTimeout(
            () => {
              void this.ordered(check);
            },
            Math.max(
              1,
              Math.min(deadline, options.mode === "quiet" ? quietAt : deadline) - Date.now(),
            ),
          );
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const activity = () => {
        if (options.mode === "quiet") quietAt = Date.now() + options.quietMs;
        check();
      };
      void this.ordered(() => {
        if (this.observers.signal.aborted) {
          abort();
          return;
        }
        if (options.mode === "quiet") quietAt = Date.now() + options.quietMs;
        this.listeners.add(activity);
        this.observers.signal.addEventListener("abort", abort, { once: true });
        check();
      });
    });
  }
  async dispose() {
    this.observers.abort(new AppError("recording_unavailable", "Recording interrupted"));
    for (const resume of this.waiting) resume();
    this.waiting.clear();
    this.listeners.clear();
    this.checkpoint = undefined;
    this.tail = [];
    await this.queue;
    this.terminal.dispose();
  }
}

export const modelLimits = {
  terminalModelPendingBytes: 8 * 1024 * 1024,
  terminalCheckpointIntervalBytes: 4 * 1024 * 1024,
  terminalRecoveryTailBytes: 8 * 1024 * 1024,
} as const;
