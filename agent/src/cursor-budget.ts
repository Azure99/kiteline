import { agentLimits } from "./limits.js";
import { AppError } from "@kiteline/shared/protocol";
import { randomUUID } from "node:crypto";

export class CursorBudget {
  private count = 0;
  reserve() {
    if (this.count >= agentLimits.cursorsPerDevice)
      throw new AppError("busy", "Too many active list reads; try again later");
    this.count++;
    let released = false;
    return () => {
      if (!released) this.count--;
      released = true;
    };
  }
}

interface Cursor<T> {
  value: T;
  timer: NodeJS.Timeout;
  busy: boolean;
  controller: AbortController;
  release: () => void;
  reading?: Promise<void>;
  closing?: Promise<void>;
}

export class CursorTable<T> {
  private entries = new Map<string, Cursor<T>>();
  constructor(
    private budget: CursorBudget,
    private closeValue: (value: T) => Promise<void>,
    private messages: { expired: string; busy: string; ended: string },
  ) {}

  acquire(
    token: string | undefined,
    create: () => T,
    signal?: AbortSignal,
    accepts: (value: T) => boolean = () => true,
  ) {
    const id = token ?? randomUUID();
    let cursor = this.entries.get(id);
    if (token && (!cursor || cursor.closing || !accepts(cursor.value)))
      throw new AppError("conflict", this.messages.expired);
    if (!cursor) {
      const release = this.budget.reserve();
      cursor = {
        value: create(),
        release,
        busy: false,
        controller: new AbortController(),
        timer: setTimeout(() => void this.release(id), agentLimits.cursorLifetime),
      };
      this.entries.set(id, cursor);
    }
    if (cursor.busy) throw new AppError("busy", this.messages.busy);
    cursor.busy = true;
    cursor.timer.refresh();
    const readingSignal = AbortSignal.any([cursor.controller.signal, ...(signal ? [signal] : [])]);
    let finishRead!: () => void;
    cursor.reading = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    return {
      id,
      value: cursor.value,
      signal: readingSignal,
      finish: async (keep: boolean) => {
        cursor.busy = false;
        // Release waits for this read, so resolve it before awaiting resource cleanup.
        finishRead();
        if (!keep || readingSignal.aborted) await this.release(id);
      },
    };
  }

  async release(id: string) {
    const cursor = this.entries.get(id);
    if (!cursor) return;
    clearTimeout(cursor.timer);
    cursor.controller.abort(new AppError("cancelled", this.messages.ended));
    cursor.closing ??= (async () => {
      await cursor.reading;
      await this.closeValue(cursor.value);
      this.entries.delete(id);
      cursor.release();
    })();
    await cursor.closing;
  }

  async close(predicate: (value: T) => boolean = () => true) {
    await Promise.all(
      [...this.entries]
        .filter(([, cursor]) => predicate(cursor.value))
        .map(([id]) => this.release(id)),
    );
  }
}
