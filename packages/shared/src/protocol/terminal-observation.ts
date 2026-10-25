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
