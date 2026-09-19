import release from "../version.json" with { type: "json" };

export const protocolVersion = 1;
export const appVersion = release.version;
export const terminalProfile = "xterm-c1";
export { rpcMutates } from "./rpc.js";
export type {
  RpcMethods,
  RpcMethod,
  RpcParams,
  RpcResult,
  RpcRequest,
  RpcReply,
  RpcArguments,
  GitWriteMethod,
  GitWriteArguments,
} from "./rpc.js";

export const limits = {
  controlMessageBytes: 1024 * 1024,
  resultBytes: 512 * 1024,
  dataChunkBytes: 64 * 1024,
  filePendingFrames: 256,
  filePendingBytes: 2 * 1024 * 1024,
  pendingRequestsPerDevice: 32,
  listPageEntries: 500,
  cursorLifetime: 60_000,
  cursorsPerDevice: 16,
  copyNameAttempts: 1000,
  searchMatches: 1000,
  searchLineBytes: 2048,
  searchPathBytes: 4096,
  searchRanges: 128,
  searchErrorBytes: 4096,
  discoveryDirectories: 10_000,
  discoverySlice: 2000,
  diffRenderLines: 2000,
  diffRawBytes: 32 * 1024,
  watchDebounce: 300,
  visibleRefreshInterval: 15_000,
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
export type Reply<T = unknown, E = unknown> =
  | { id: string; outcome: "succeeded"; result: T }
  | { id: string; outcome: "failed" | "partial" | "unknown"; error: KitelineError; result?: E };
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
  release?: { agentVersion: string | null; serverVersion: string; observedAt: string };
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
export interface FileListing {
  path: string;
  resolvedPath: string;
  entries: Page<Entry>;
}
export interface FileInspection {
  entry: Entry;
  targetVersion: string;
  suggestedName?: string;
}
export interface SearchMatch {
  path: string;
  line?: number;
  text?: string;
  ranges?: [number, number][];
  truncated?: boolean;
}
export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}
export interface PathError {
  path: string;
  error: KitelineError;
}
export interface Repo {
  id: string;
  path: string;
  rootPath: string;
  gitDir: string;
  commonDir: string;
  linked: boolean;
  available: boolean;
}
export interface RepoDiscovery {
  repos: Repo[];
  complete: boolean;
  scanCursor?: string;
  issues: PathError[];
}
export interface HeadIdentity {
  symbolicRef: string | null;
  oid: string | null;
}
export type GitType = "file" | "symlink" | "gitlink" | "absent" | "directory" | "other";
export interface GitEntry {
  path: string;
  oldPath?: string;
  types: {
    head?: GitType;
    index?: GitType;
    worktree: GitType;
    base?: GitType;
    ours?: GitType;
    theirs?: GitType;
  };
  indexStatus: string;
  worktreeStatus: string;
  conflict: boolean;
  submodule?: { commitChanged: boolean; trackedDirty: boolean; untrackedDirty: boolean };
}
export interface GitStatus {
  head: HeadIdentity;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  entries: GitEntry[];
  offset: number;
  nextOffset?: number;
  totalCount: number;
  listToken: string;
  stagedCount: number;
  hasConflicts: boolean;
  indexToken?: string;
  operation?: GitOperation;
  truncated: boolean;
}
export interface GitOperation {
  kind: "merge" | "rebase" | "am" | "cherry-pick" | "revert" | "unknown";
  token?: string;
  canContinue: boolean;
  canAbort: boolean;
  reason?: string;
}
export interface GitRemotes {
  remotes: { name: string; fetchUrls: string[]; pushUrls: string[] }[];
  upstream?: string;
  defaultFetchRemote?: string;
  defaultPushRemote?: string;
  pushTarget?: string;
}
export interface ListeningPorts {
  ports: number[];
  truncated: boolean;
}
export interface DiffSummary {
  path: string;
  oldPath?: string;
  status: string;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
}
export interface GitDiff {
  patch: string;
  summary: DiffSummary;
  truncated: boolean;
}
export type DiscardScope = "worktree" | "all";
export interface GitReview {
  paths: string[];
  summary: { path: string; action: "restore" | "delete" }[];
  reviewToken: string;
}
export interface Commit {
  oid: string;
  parents: string[];
  author: string;
  time: string;
  subject: string;
}
export interface GitHistory {
  commits: Commit[];
  anchorOid?: string;
  nextOffset?: number;
}
export interface CommitFile {
  path: string;
  oldPath?: string;
  status: string;
  binary: boolean;
}
export interface CommitFiles {
  files: CommitFile[];
  parentOid?: string;
  nextOffset?: number;
}
export interface Branch {
  name: string;
  oid: string;
  current: boolean;
  worktreePath?: string;
}
export interface FileItemResult {
  path: string;
  targetPath?: string;
  outcome: Outcome;
  error?: KitelineError;
  completedItems?: number;
  failures?: PathError[];
  truncated?: boolean;
}
export interface CopyItem {
  path: string;
  targetPath: string;
  collision: "error" | "replace";
  expectedTargetVersion?: string;
}
export interface FileProgress {
  phase: "queued" | "running";
  currentPath?: string;
  completedItems?: number;
  bytes?: number;
}
export type WorkspaceEvent =
  | { type: "workspace.changed"; workspaceId: string; scopes: ("files" | "git" | "repos")[] }
  | { type: "sessions.changed"; workspaceId: string }
  | { type: "watch.status"; workspaceId: string; status: "normal" | "degraded"; reason?: string };
export type AgentEvent = WorkspaceEvent | ({ type: "request.progress"; id: string } & FileProgress);
export type BrowserEvent =
  | { type: "devices.changed"; devices: Device[] }
  | (AgentEvent & { deviceId: string })
  | {
      type: "channel.failed";
      channelId: string;
      deviceId: string;
      workspaceId: string;
      path: string;
      purpose: "text" | "image" | "download";
      error: KitelineError;
      outcome: "failed";
    };
export interface TextFormat {
  bom: boolean;
  lineEnding: "lf" | "crlf";
  mixedLineEndings?: boolean;
}
export interface FileMeta {
  size: number;
  contentType: string;
  filename: string;
  targetPath?: string;
  revision?: string;
  resolvedPath?: string;
  mode?: number;
  bom?: boolean;
  lineEnding?: TextFormat["lineEnding"];
  mixedLineEndings?: boolean;
  width?: number;
  height?: number;
}
export interface UploadedFile {
  path: string;
  size: number;
}
export interface SavedFile extends UploadedFile {
  revision: string;
}
export interface ChannelReady<T = TerminalMeta | FileMeta> {
  channelId: string;
  meta: T;
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
    public outcome: "failed" | "partial" | "unknown",
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
