import { StringDecoder } from "node:string_decoder";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { AppError, limits } from "@kiteline/shared/protocol";
import {
  atGround,
  mouseEncodingVT,
  adaptTerminalScrolling,
  terminalOptions,
  initializeTerminalUnicode,
} from "@kiteline/shared/terminal";
import type { TerminalEvent } from "@kiteline/shared/protocol/ipc";

const { Terminal } = headless;
const { SerializeAddon } = serialize;

export interface Snapshot {
  data: Buffer;
  cols: number;
  rows: number;
  historyLimited: boolean;
  tail: TerminalEvent[];
}
export class Model {
  readonly terminal: InstanceType<typeof Terminal>;
  private serializer = new SerializeAddon();
  private decoder = new StringDecoder("utf8");
  private queue: Promise<unknown> = Promise.resolve();
  private pendingOutput?: { parts: string[]; bytes: number };
  private pendingBytes = 0;
  private checkpoint?: Omit<Snapshot, "tail">;
  private tail: TerminalEvent[] = [];
  private tailBytes = 0;
  private snapshotError?: Error;
  private stopped = false;
  private listeners = new Set<(event: TerminalEvent) => void>();
  private waiting = new Set<() => void>();
  constructor(
    cols: number,
    rows: number,
    readonly historyLines: number,
    private fault: (error: Error) => void,
  ) {
    this.terminal = new Terminal({ ...terminalOptions(historyLines), cols, rows });
    initializeTerminalUnicode(this.terminal);
    adaptTerminalScrolling(this.terminal);
    this.terminal.loadAddon(this.serializer);
    this.rotate();
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
      }
    }).catch((error: Error) => this.fault(error));
    this.pendingOutput = batch;
  }
  resize(cols: number, rows: number) {
    void this.ordered(() => {
      if (this.stopped || (this.terminal.cols === cols && this.terminal.rows === rows)) return;
      this.terminal.resize(cols, rows);
      this.record({ type: "resize", cols, rows });
    }).catch((error: Error) => this.fault(error));
  }
  waitForSize(cols: number, rows: number, timeout: number) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = () => {
        if (this.terminal.cols === cols && this.terminal.rows === rows) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new AppError(
            "timeout",
            "Actual terminal dimensions were not received; reopen the display and try again",
          ),
        );
      }, timeout);
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
        this.serializer.serialize({ scrollback }) + mouseEncodingVT(this.terminal),
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
    this.tailBytes += event.type === "output" ? Buffer.byteLength(event.data) : 32;
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
  async dispose() {
    this.stopped = true;
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
