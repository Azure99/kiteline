import type { KitelineError, Reply } from "./index.js";

export interface RecorderConfig {
  terminalInputBytes: number;
}
export interface TerminalIdentity {
  socket: string;
  paneId: string;
  windowId: string;
}
export interface CreateTerminal {
  sessionId: string;
  socket: string;
  workspacePath: string;
  shell: string;
  command?: string;
  cols: number;
  rows: number;
  historyLines: number;
}
export interface RecoverTerminal extends TerminalIdentity {
  sessionId: string;
  cols: number;
  rows: number;
  historyLines: number;
}
export type TerminalSource =
  | ({ type: "create" } & CreateTerminal)
  | ({ type: "recover" } & RecoverTerminal);
export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "resize"; cols: number; rows: number };
export type BrowserTerminalInput =
  | { type: "paste"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "consumed"; bytes: number };
export type TerminalFrame =
  | {
      type: "restore.begin";
      cols: number;
      rows: number;
      historyLines: number;
      snapshotBytes: number;
      historyLimited: boolean;
      historyGap: boolean;
    }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ready" }
  | { type: "ended"; exitCode: number | null }
  | { type: "error"; code: string; message: string }
  | { type: "input.error"; code: string; message: string; outcome: "failed" | "unknown" };
export type RecorderRequest =
  | ({ id: string } & TerminalSource)
  | { type: "cancelCreate"; id: string; sessionId: string; createId: string }
  | { type: "end" | "redraw"; id: string; sessionId: string }
  | {
      type: "attach";
      id: string;
      sessionId: string;
      attachmentId: string;
      historyGap: boolean;
      history: "retained" | "screen";
    }
  | { type: "input"; sessionId: string; attachmentId: string; dataBase64: string }
  | (BrowserTerminalInput & { sessionId: string; attachmentId: string })
  | { type: "detach"; sessionId: string; attachmentId: string };
export type RecorderMessage =
  | { type: "reply"; reply: Reply }
  | { type: "frame"; sessionId: string; attachmentId: string; frame: TerminalFrame }
  | { type: "bytes"; sessionId: string; attachmentId: string; dataBase64: string }
  | { type: "fault"; sessionId: string; error: KitelineError }
  | { type: "ended"; sessionId: string; exitCode: number | null };

type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;
export type RecorderCall = WithoutId<RecorderRequest>;

// Small frames also consume credit for their WebSocket and recorder IPC envelopes.
export function terminalOutputCost(payloadBytes: number) {
  return Math.max(payloadBytes, 128);
}
