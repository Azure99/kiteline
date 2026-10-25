import { AppError, integer, record, string } from "./validation.js";
import { limits } from "./limits.js";

export const defaultTerminalOperationTimeoutMs = 5_000;
export const defaultTerminalWaitTimeoutMs = 1_000;
export const defaultTerminalQuietMs = 300;
export const maxTerminalTimeoutMs = 10_000;
export const maxTerminalQuietMs = 10_000;

export interface TerminalPosition {
  epoch: string;
  seq: number;
}
export interface ScreenOptions {
  tail?: number;
  attrs?: boolean;
}
export interface ScreenPosition extends TerminalPosition {
  tail: number | null;
  attrs: boolean;
}
export interface SnapshotOptions extends ScreenOptions {
  ifChanged?: ScreenPosition;
}
export interface InputPosition {
  epoch: string;
  inputSeq: number;
}
export type TerminalColor = { palette: number } | { rgb: string };
export interface CellStyle {
  fg?: TerminalColor;
  bg?: TerminalColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
  invisible?: true;
  blink?: true;
  strikethrough?: true;
  overline?: true;
}
export interface ScreenLine {
  text: string;
  wrapped: boolean;
  attrs?: (CellStyle & { start: number; end: number })[];
}
export interface TerminalScreen {
  position: ScreenPosition;
  input: InputPosition;
  cols: number;
  rows: number;
  active: "normal" | "alternate";
  cursor: { x: number; y: number; visible: boolean };
  screen: ScreenLine[];
  tail?: { buffer: "normal"; omitted: number; lines: ScreenLine[] };
  historyGap: boolean;
  synchronizedOutput: boolean;
}
export type SnapshotResult =
  | (TerminalScreen & { reason: "full" | "reset" })
  | { reason: "unchanged"; position: ScreenPosition; input: InputPosition };
export const terminalKeys = [
  "Enter",
  "Escape",
  "CtrlC",
  "Tab",
  "Up",
  "Down",
  "PageUp",
  "PageDown",
] as const;
export type SessionInput =
  | { type: "paste"; text: string; enter?: boolean }
  | { type: "text"; text: string; enter?: boolean }
  | {
      type: "key";
      key: (typeof terminalKeys)[number];
    };
export type ScreenWait = ScreenOptions &
  ({ mode: "quiet"; quietMs: number } | { mode: "change"; after: TerminalPosition });
export interface ScreenWaitResult {
  reason: "quiet" | "changed" | "reset" | "timeout";
  snapshot: TerminalScreen;
}
export type TerminalOperation =
  | { type: "session.send"; input: SessionInput; ifInput?: InputPosition; deadline: number }
  | { type: "session.resize"; cols: number; rows: number; deadline: number };

function parseEpoch(value: unknown) {
  return string(value, "epoch", 128);
}

export function parseTerminalPosition(value: unknown): TerminalPosition {
  const position = record(value);
  return {
    epoch: parseEpoch(position.epoch),
    seq: integer(position.seq, "seq", 0, Number.MAX_SAFE_INTEGER),
  };
}

export function parseInputPosition(value: unknown): InputPosition {
  const position = record(value);
  return {
    epoch: parseEpoch(position.epoch),
    inputSeq: integer(position.inputSeq, "inputSeq", 0, Number.MAX_SAFE_INTEGER),
  };
}

export function parseTerminalTail(value: unknown, name = "tail") {
  return integer(
    value,
    `${name}: expected an integer from 0 to ${limits.terminalHistoryLines} lines`,
    0,
    limits.terminalHistoryLines,
  );
}

function optionalBoolean(value: unknown, name: string) {
  if (value === undefined || typeof value === "boolean") return value;
  throw new AppError("invalid_argument", `Invalid ${name}`);
}

function parseScreenOptions(params: Record<string, unknown>): ScreenOptions {
  return {
    tail: params.tail === undefined ? undefined : parseTerminalTail(params.tail),
    attrs: optionalBoolean(params.attrs, "attrs"),
  };
}

export function parseScreenPosition(value: unknown): ScreenPosition {
  const position = record(value);
  if (typeof position.attrs !== "boolean")
    throw new AppError("invalid_argument", "ifChanged.attrs must be a boolean");
  return {
    epoch: parseEpoch(position.epoch),
    seq: integer(position.seq, "seq", 0, Number.MAX_SAFE_INTEGER),
    tail: position.tail === null ? null : parseTerminalTail(position.tail, "ifChanged.tail"),
    attrs: position.attrs,
  };
}

export function parseSnapshotOptions(params: Record<string, unknown>): SnapshotOptions {
  const options: SnapshotOptions = parseScreenOptions(params);
  if (params.ifChanged !== undefined) options.ifChanged = parseScreenPosition(params.ifChanged);
  return options;
}

export function parseTerminalKey(value: unknown): (typeof terminalKeys)[number] {
  const key = terminalKeys.find((key) => key === value);
  if (key === undefined)
    throw new AppError("invalid_argument", `Key must be one of: ${terminalKeys.join(", ")}`);
  return key;
}

export function parseSessionInput(value: unknown): SessionInput {
  const input = record(value);
  if (input.type === "text" || input.type === "paste") {
    if (typeof input.text !== "string")
      throw new AppError("invalid_argument", "Input text must be a string");
    return {
      type: input.type,
      text: input.text,
      enter: optionalBoolean(input.enter, "enter"),
    };
  }
  if (input.type === "key") return { type: "key", key: parseTerminalKey(input.key) };
  throw new AppError("invalid_argument", "Input must be text, paste, or a supported named key");
}

export function parseTerminalWaitMode(value: unknown): "quiet" | "change" {
  if (value === "quiet" || value === "change") return value;
  throw new AppError("invalid_argument", "Wait mode must be quiet or change");
}

export function parseTerminalQuietMs(value: unknown) {
  return integer(
    value,
    `quietMs: expected an integer from 1 to ${maxTerminalQuietMs} ms`,
    1,
    maxTerminalQuietMs,
  );
}

export function parseTerminalTimeoutMs(value: unknown) {
  return integer(
    value,
    `timeoutMs: expected an integer from 1 to ${maxTerminalTimeoutMs} ms`,
    1,
    maxTerminalTimeoutMs,
  );
}

export function parseScreenWait(params: Record<string, unknown>): ScreenWait {
  const options = parseScreenOptions(params);
  const mode = parseTerminalWaitMode(params.mode === undefined ? "quiet" : params.mode);
  if (mode === "quiet")
    return {
      ...options,
      mode,
      quietMs: parseTerminalQuietMs(params.quietMs ?? defaultTerminalQuietMs),
    };
  return { ...options, mode, after: parseTerminalPosition(params.after) };
}

export function parseTerminalCols(value: unknown) {
  return integer(
    value,
    `cols: expected an integer from 1 to ${limits.terminalMaxCols}`,
    1,
    limits.terminalMaxCols,
  );
}

export function parseTerminalRows(value: unknown) {
  return integer(
    value,
    `rows: expected an integer from 1 to ${limits.terminalMaxRows}`,
    1,
    limits.terminalMaxRows,
  );
}
