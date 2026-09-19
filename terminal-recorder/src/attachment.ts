import { AppError, limits, terminalProfile } from "@kiteline/shared/protocol";
import type { TerminalEvent, TerminalFrame } from "@kiteline/shared/ipc";
import type { Snapshot } from "./model.js";

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
    terminalProfile,
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
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(
    readonly id: string,
    private stallTimeout: number,
    private send: (piece: Piece) => boolean,
    private onClose: () => void,
  ) {}
  start(snapshot: Snapshot, historyLines: number, historyGap: boolean) {
    this.restoration = restore(snapshot, historyLines, historyGap);
    this.pump();
  }
  output = (event: TerminalEvent) => {
    if (this.closed) return;
    const bytes = event.type === "output" ? Buffer.byteLength(event.data) : 32;
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
    if (!Number.isSafeInteger(bytes) || bytes < this.consumed || bytes > this.sent) {
      this.fail(
        new AppError("invalid_argument", "Invalid terminal output consumption acknowledgement"),
      );
      return;
    }
    if (bytes === this.consumed) return;
    this.consumed = bytes;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pump();
    this.checkStall();
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
    this.pieceCost = event.type === "output" ? Buffer.byteLength(event.data) : 32;
    this.pieces = eventPieces(event);
    return this.next();
  }
  private pump() {
    while (!this.closed) {
      const piece = this.held ?? this.next();
      if (!piece) break;
      if (
        Buffer.isBuffer(piece) &&
        this.sent - this.consumed + piece.length > limits.terminalOutstandingBytes
      ) {
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
      if (Buffer.isBuffer(piece)) this.sent += piece.length;
      else if (piece.type === "ended") {
        this.close();
        return;
      }
    }
    this.checkStall();
  }
  private checkStall() {
    if (!this.closed && this.sent > this.consumed && !this.timer)
      this.timer = setTimeout(
        () => this.fail(new AppError("timeout", "Display has stopped consuming output")),
        this.stallTimeout,
      );
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
    clearTimeout(this.timer);
    this.pending = [];
    this.held = undefined;
    this.restoration = undefined;
    this.pieces = undefined;
    this.onClose();
  }
}
