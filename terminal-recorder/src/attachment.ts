import { AppError, limits } from "@kiteline/shared/protocol";
import { terminalOutputCost } from "@kiteline/shared/protocol/ipc";
import type { TerminalEvent, TerminalFrame } from "@kiteline/shared/protocol/ipc";
import { eventCost, type Snapshot } from "./model.js";

type Piece = Buffer | TerminalFrame;
function* chunks(data: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < data.length; offset += limits.dataChunkBytes)
    yield data.subarray(offset, offset + limits.dataChunkBytes);
}
function* eventPieces(event: TerminalEvent): Generator<Piece> {
  if (event.type === "resize") yield event;
  else yield* chunks(Buffer.from(event.data));
}
function* restore(snapshot: Snapshot, historyLines: number, historyGap: boolean): Generator<Piece> {
  yield {
    type: "restore.begin",
    cols: snapshot.cols,
    rows: snapshot.rows,
    historyLines,
    snapshotBytes: snapshot.data.length,
    historyLimited: snapshot.historyLimited,
    historyGap,
  };
  yield* chunks(snapshot.data);
  for (const event of snapshot.tail) yield* eventPieces(event);
  yield { type: "ready" };
}

export class Attachment {
  private restoration?: Generator<Piece>;
  private pieces?: Generator<Piece>;
  private pieceCost = 0;
  private held?: Piece;
  private pending: (TerminalEvent | { type: "ended"; exitCode: number | null })[] = [];
  private pendingBytes = 0;
  private sent = 0;
  private consumed = 0;
  private closed = false;
  constructor(
    readonly id: string,
    private send: (piece: Piece) => boolean,
    private onClose: () => void,
    private changed: () => void,
  ) {}
  get backlog() {
    return this.closed ? 0 : this.pendingBytes;
  }
  start(snapshot: Snapshot, historyLines: number, historyGap: boolean) {
    this.restoration = restore(snapshot, historyLines, historyGap);
    this.pump();
  }
  output = (event: TerminalEvent) => {
    if (this.closed) return;
    const bytes = eventCost(event);
    if (this.pendingBytes + bytes > limits.terminalPendingBytes) {
      this.fail(
        new AppError("limit_exceeded", "Display is receiving output too slowly; reconnect"),
      );
      return;
    }
    this.pending.push(event);
    this.pendingBytes += bytes;
    this.pump();
  };
  end(exitCode: number | null) {
    if (!this.closed) {
      this.pending.push({ type: "ended", exitCode });
      this.pump();
    }
  }
  acknowledge(bytes: number) {
    if (bytes < this.consumed || bytes > this.sent) {
      this.fail(
        new AppError("invalid_argument", "Invalid terminal output consumption acknowledgement"),
      );
      return;
    }
    if (bytes === this.consumed) return;
    this.consumed = bytes;
    this.pump();
  }
  private next(): Piece | undefined {
    if (this.restoration) {
      const next = this.restoration.next();
      if (!next.done) return next.value;
      this.restoration = undefined;
    }
    if (this.pieces) {
      const next = this.pieces.next();
      if (!next.done) return next.value;
      this.pieces = undefined;
      this.pendingBytes -= this.pieceCost;
      this.pieceCost = 0;
    }
    const event = this.pending.shift();
    if (!event) return;
    if (event.type === "ended") return event;
    this.pieceCost = eventCost(event);
    this.pieces = eventPieces(event);
    return this.next();
  }
  private pump() {
    while (!this.closed) {
      const piece = this.held ?? this.next();
      if (!piece) break;
      const credit = terminalOutputCost(
        Buffer.isBuffer(piece) ? piece.length : Buffer.byteLength(JSON.stringify(piece)),
      );
      if (this.sent - this.consumed + credit > terminalOutstandingBytes) {
        this.held = piece;
        break;
      }
      this.held = undefined;
      if (!this.send(piece)) {
        this.fail(
          new AppError(
            "limit_exceeded",
            "Display transmission backlog exceeds the limit; reconnect",
          ),
        );
        return;
      }
      this.sent += credit;
      if (!Buffer.isBuffer(piece) && piece.type === "ended") {
        this.close();
        return;
      }
    }
    this.changed();
  }
  fail(error: Error) {
    if (this.closed) return;
    this.send({
      type: "error",
      code: error instanceof AppError ? error.code : "io_error",
      message: error.message,
    });
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.held = undefined;
    this.restoration = undefined;
    this.pieces = undefined;
    this.onClose();
  }
}

export const terminalOutstandingBytes = 256 * 1024;
