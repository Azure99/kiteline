export const protocolVersion = 1;
export const appVersion = "0.1.0";
export const terminalProfile = "xterm-c1";

export const limits = {
  controlMessageBytes: 1024 * 1024,
  resultBytes: 512 * 1024,
  dataChunkBytes: 64 * 1024,
  pendingRequestsPerDevice: 32,
  listPageEntries: 500,
  cursorLifetime: 60_000,
  cursorsPerDevice: 16,
  heartbeatInterval: 20_000,
  heartbeatTimeout: 60_000,
  tcpKeepAliveDelayMs: 20_000,
  terminalOutstandingBytes: 256 * 1024,
  terminalPendingBytes: 1024 * 1024,
  terminalModelPendingBytes: 8 * 1024 * 1024,
  terminalCheckpointIntervalBytes: 4 * 1024 * 1024,
  terminalRecoveryTailBytes: 8 * 1024 * 1024,
  terminalSnapshotBytes: 16 * 1024 * 1024,
  terminalInitialCols: 80,
  terminalInitialRows: 24,
  terminalMaxCols: 500,
  terminalMaxRows: 200,
  setupTokenLifetime: 30 * 60_000,
  bindingLifetime: 10 * 60_000,
} as const;

export type Outcome = "succeeded" | "failed" | "partial" | "unknown";
export interface KitelineError {
  code: string;
  message: string;
  details?: unknown;
}
export type Reply<T = unknown> =
  | { id: string; outcome: "succeeded"; result: T }
  | { id: string; outcome: "failed" | "partial" | "unknown"; error: KitelineError; result?: T };
export interface Workspace {
  id: string;
  name: string;
  path: string;
}
export interface Session {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  historyLines: number;
  state: "starting" | "running";
  terminalProfile: string;
  webStatus: "available" | "recovering" | "unavailable";
  historyGap: boolean;
  webReason?: string;
}
export interface TerminalMeta {
  sessionId: string;
  historyLines: number;
  terminalProfile: string;
  terminalInputBytes: number;
  controlMessageBytes: number;
}
export interface Shortcut {
  id: string;
  name: string;
  command: string;
}
export interface Metadata {
  schemaVersion: 1;
  revision: number;
  workspaces: Workspace[];
  shortcuts: Shortcut[];
  settings: { historyLines: number };
}
export interface Device {
  id: string;
  name: string;
  status: "online" | "offline" | "revoked";
  lastSeenAt: string | null;
  snapshot?: Metadata;
  editorBytes?: number;
}
export interface Entry {
  name: string;
  path: string | null;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
  mtime?: string;
  linkTarget?: string;
  unavailableReason?: "invalid_utf8";
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
}
export interface DirectoryListing {
  path: string;
  parentPath?: string;
  entries: Page<Entry>;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export class OperationError extends AppError {
  constructor(
    code: string,
    message: string,
    public outcome: "partial" | "unknown",
    public result?: unknown,
    details?: unknown,
  ) {
    super(code, message, details);
  }
}
export function errorReply(id: string, error: unknown): Reply {
  return {
    id,
    outcome: error instanceof OperationError ? error.outcome : "failed",
    error: asError(error),
    ...(error instanceof OperationError && error.result !== undefined
      ? { result: error.result }
      : {}),
  };
}
export function asError(error: unknown): KitelineError {
  if (error instanceof AppError)
    return { code: error.code, message: error.message, details: error.details };
  const code = (error as { code?: string })?.code;
  const mapped: Record<string, string> = {
    ENOENT: "not_found",
    EEXIST: "conflict",
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    ABORT_ERR: "cancelled",
  };
  return {
    code: (code && mapped[code]) || "io_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_argument", "Expected an object");
  return value as Record<string, unknown>;
}
export function string(value: unknown, name = "value", max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0"))
    throw new AppError("invalid_argument", `Invalid ${name}`);
  return value;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError("invalid_argument", `Invalid ${name}`);
  return value;
}
export function checkMetadata(value: unknown): Metadata {
  const data = record(value);
  if (data.schemaVersion !== 1 || !Array.isArray(data.workspaces) || !Array.isArray(data.shortcuts))
    throw new AppError("unsupported", "Invalid metadata schema");
  integer(data.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  for (const item of data.workspaces) {
    const w = record(item);
    string(w.id, "workspace id", 128);
    string(w.name, "workspace name", 256);
    string(w.path, "workspace path");
  }
  for (const item of data.shortcuts) {
    const s = record(item);
    string(s.id, "shortcut id", 128);
    string(s.name, "shortcut name", 256);
    string(s.command, "command", 65536);
  }
  integer(record(data.settings).historyLines, "historyLines", 0, 50_000);
  return data as unknown as Metadata;
}
