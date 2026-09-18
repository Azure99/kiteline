import type { KitelineError, Reply } from "./index.js";

export interface RecorderConfig {
  terminalInputBytes: number;
  terminalStallTimeout: number;
  channelPairTimeout: number;
}
export interface TerminalIdentity {
  socket: string;
  tmuxSession: string;
  paneId: string;
  windowId: string;
}
export interface CreateTerminal {
  sessionId: string;
  socket: string;
  tmuxSession: string;
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
export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "resize"; cols: number; rows: number };
export type TerminalFrame =
  | {
      type: "restore.begin";
      terminalProfile: string;
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
  | ({ type: "create"; id: string } & CreateTerminal)
  | ({ type: "recover"; id: string } & RecoverTerminal)
  | { type: "end" | "redraw"; id: string; sessionId: string }
  | {
      type: "attach";
      id: string;
      sessionId: string;
      attachmentId: string;
      terminalProfile: string;
      historyGap: boolean;
      history: "retained" | "screen";
    }
  | { type: "input"; sessionId: string; attachmentId: string; dataBase64: string }
  | { type: "paste"; sessionId: string; attachmentId: string; text: string }
  | { type: "resize"; sessionId: string; attachmentId: string; cols: number; rows: number }
  | { type: "detach"; sessionId: string; attachmentId: string }
  | { type: "consumed"; sessionId: string; attachmentId: string; bytes: number };
export type RecorderMessage =
  | { type: "reply"; reply: Reply }
  | { type: "frame"; sessionId: string; attachmentId: string; frame: TerminalFrame }
  | { type: "bytes"; sessionId: string; attachmentId: string; dataBase64: string }
  | { type: "fault"; sessionId: string; error: KitelineError }
  | { type: "ended"; sessionId: string; exitCode: number | null };

type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;
export type RecorderCall = WithoutId<RecorderRequest>;
