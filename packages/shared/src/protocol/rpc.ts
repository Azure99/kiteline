import type {
  Branch,
  CommitFiles,
  CopyItem,
  DirectoryListing,
  DiscardScope,
  Entry,
  FileInspection,
  FileItemResult,
  FileListing,
  GitDiff,
  GitHistory,
  GitOperation,
  GitRemotes,
  GitReview,
  GitStatus,
  HeadIdentity,
  ListeningPorts,
  Metadata,
  Reply,
  RepoDiscovery,
  SearchResult,
  Session,
  Shortcut,
  Workspace,
} from "./index.js";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSummary,
  TaskSchedule,
  TaskRun,
  TaskRunSummary,
  TaskOutput,
} from "./tasks.js";

import type {
  SnapshotOptions,
  SnapshotResult,
  InputPosition,
  TerminalPosition,
  SessionInput,
  ScreenOptions,
  ScreenWaitResult,
} from "./terminal-observation.js";

type Contract<P, R, E = unknown> = { params: P; result: R; errorResult: E };
type WorkspaceParams = { workspaceId: string };
type FileParams = WorkspaceParams & { path: string };
type RepoParams = WorkspaceParams & { repoId: string };
type SessionParams = WorkspaceParams & { sessionId: string };
type GitOutput = { stdout: string; stderr: string; truncated: boolean };
type GitPaths = RepoParams & { paths: string[] };
type GitFinish = RepoParams & { expectedOperation: { kind: GitOperation["kind"]; token: string } };
type BranchTarget = RepoParams & { name: string; refOid: string };
type FileResults = { items: FileItemResult[] };

interface GitWriteMethods {
  "git.stage": Contract<GitPaths, { changedPaths: string[] }>;
  "git.unstage": Contract<GitPaths, { changedPaths: string[] }>;
  "git.discard": Contract<
    GitPaths & { scope: DiscardScope; reviewToken: string },
    { changedPaths: string[] }
  >;
  "git.commit": Contract<
    RepoParams & { message: string; indexToken: string },
    { commitOid: string }
  >;
  "git.branch.create": Contract<
    RepoParams & { name: string; startOid?: string; switch: boolean },
    { created: boolean; switched: boolean; head: HeadIdentity }
  >;
  "git.branch.switch": Contract<BranchTarget, { head: HeadIdentity }>;
  "git.branch.delete": Contract<BranchTarget, { deleted: boolean }>;
  "git.fetch": Contract<RepoParams & { remote?: string }, GitOutput>;
  "git.pull": Contract<RepoParams & { expectedHead: HeadIdentity }, GitOutput>;
  "git.push": Contract<RepoParams & { expectedHead: HeadIdentity }, GitOutput>;
  "git.continue": Contract<
    GitFinish,
    GitOutput & { headOid: string | null; operationAfter?: GitOperation }
  >;
  "git.abort": Contract<
    GitFinish,
    GitOutput & { headOid: string | null; operationAfter?: GitOperation }
  >;
}

interface RpcMethods extends GitWriteMethods {
  "tasks.list": Contract<
    { offset?: number },
    { items: ScheduledTaskSummary[]; offset: number; total: number }
  >;
  "tasks.get": Contract<{ taskId: string }, ScheduledTask>;
  "tasks.preview": Contract<
    { schedule: TaskSchedule; timezone?: string },
    { timezone: string; nextRunAts: string[] }
  >;
  "tasks.create": Contract<{ taskId: string; input: ScheduledTaskInput }, ScheduledTask>;
  "tasks.update": Contract<
    { taskId: string; expectedRevision: number; changes: Partial<ScheduledTaskInput> },
    ScheduledTask
  >;
  "tasks.pause": Contract<{ taskId: string }, ScheduledTask>;
  "tasks.resume": Contract<{ taskId: string }, ScheduledTask>;
  "tasks.acknowledge": Contract<{ taskId: string; runId: string }, ScheduledTask>;
  "tasks.delete": Contract<{ taskId: string; acknowledgeRunId?: string }, { removed: true }>;
  "tasks.run": Contract<{ taskId: string; runId: string }, TaskRun>;
  "runs.list": Contract<
    { taskId: string; offset?: number },
    { items: TaskRunSummary[]; offset: number; total: number }
  >;
  "runs.get": Contract<{ runId: string }, TaskRun>;
  "runs.output": Contract<
    { runId: string; stream: "stdout" | "stderr"; offset: number; limit?: number },
    TaskOutput
  >;
  "runs.stop": Contract<{ runId: string }, TaskRun>;
  "ports.list": Contract<Record<string, never>, ListeningPorts>;
  "directories.list": Contract<{ absolutePath: string; cursor?: string }, DirectoryListing>;
  "cursors.release": Contract<{ kind: "directory" | "repo"; id: string }, { released: true }>;
  "directories.mkdir": Contract<{ absolutePath: string }, { path: string }>;
  "workspaces.add": Contract<{ absolutePath: string; name?: string }, Workspace>;
  "workspaces.rename": Contract<WorkspaceParams & { name: string }, Workspace>;
  "workspaces.remove": Contract<WorkspaceParams, { removed: boolean }>;
  "sessions.list": Contract<{ workspaceId?: string }, { sessions: Session[] }>;
  "sessions.create": Contract<WorkspaceParams & { name?: string; shortcutId?: string }, Session>;
  "sessions.rename": Contract<SessionParams & { name: string }, Session>;
  "sessions.end": Contract<SessionParams, { ended: boolean }>;
  "sessions.recover": Contract<SessionParams, Session>;
  "sessions.redraw": Contract<SessionParams, Session>;
  "sessions.snapshot": Contract<SessionParams & SnapshotOptions, SnapshotResult>;
  "sessions.send": Contract<
    SessionParams & { input: SessionInput; ifInput?: InputPosition; timeoutMs?: number },
    { before: TerminalPosition; input: InputPosition }
  >;
  "sessions.wait": Contract<
    SessionParams &
      ScreenOptions & { timeoutMs?: number } & (
        | { mode?: "quiet"; quietMs?: number }
        | { mode: "change"; after: TerminalPosition }
      ),
    ScreenWaitResult
  >;
  "sessions.resize": Contract<
    SessionParams & { cols: number; rows: number; timeoutMs?: number },
    { cols: number; rows: number }
  >;
  "settings.update": Contract<{ historyLines: number }, Metadata["settings"]>;
  "shortcuts.put": Contract<Omit<Shortcut, "id"> & { id?: string }, Shortcut>;
  "shortcuts.remove": Contract<{ id: string }, { removed: boolean }>;
  "files.list": Contract<FileParams & { cursor?: string }, FileListing>;
  "files.inspect": Contract<FileParams & { suggestCopyName?: boolean }, FileInspection>;
  "files.create": Contract<FileParams & { kind: "file" | "directory" }, Entry>;
  "files.rename": Contract<FileParams & { newName: string }, { from: string; to: string }>;
  "files.copy": Contract<WorkspaceParams & { items: CopyItem[] }, FileResults, FileResults>;
  "files.move": Contract<WorkspaceParams & { items: CopyItem[] }, FileResults, FileResults>;
  "files.delete": Contract<WorkspaceParams & { paths: string[] }, FileResults, FileResults>;
  "files.search": Contract<
    WorkspaceParams & { mode: "name" | "content"; query: string; includeIgnored: boolean },
    SearchResult
  >;
  "repos.discover": Contract<WorkspaceParams & { scanCursor?: string }, RepoDiscovery>;
  "git.status": Contract<RepoParams & { offset?: number; expectedListToken?: string }, GitStatus>;
  "git.diff": Contract<
    RepoParams & { path: string } & (
        | { side: "worktree" | "staged" }
        | { side: "commit"; commitOid: string; parentOid?: string }
      ),
    GitDiff
  >;
  "git.history": Contract<RepoParams & { anchorOid?: string; offset?: number }, GitHistory>;
  "git.commitMessage": Contract<RepoParams & { commitOid: string }, { message: string }>;
  "git.commitFiles": Contract<
    RepoParams & { commitOid: string; parentOid?: string; offset?: number },
    CommitFiles
  >;
  "git.branches": Contract<RepoParams, { branches: Branch[] }>;
  "git.remotes": Contract<RepoParams, GitRemotes>;
  "git.review": Contract<GitPaths & { scope: DiscardScope }, GitReview>;
}

export type RpcMethod = keyof RpcMethods;
interface RpcTraits {
  responseLoss: "read-error" | "unknown";
  deadline: "rpcTimeout" | "searchTimeout" | "gitWriteTimeout" | "none";
  oversizedSuccess: "failed" | "unknown";
}

const read = {
  responseLoss: "read-error",
  deadline: "rpcTimeout",
  oversizedSuccess: "unknown",
} satisfies RpcTraits;
const write = {
  responseLoss: "unknown",
  deadline: "rpcTimeout",
  oversizedSuccess: "unknown",
} satisfies RpcTraits;
const gitWrite = {
  responseLoss: "unknown",
  deadline: "gitWriteTimeout",
  oversizedSuccess: "unknown",
} satisfies RpcTraits;

export const rpcTraits = {
  "tasks.list": read,
  "tasks.get": read,
  "tasks.preview": read,
  "tasks.create": write,
  "tasks.update": write,
  "tasks.pause": write,
  "tasks.resume": write,
  "tasks.acknowledge": write,
  "tasks.delete": write,
  "tasks.run": write,
  "runs.list": read,
  "runs.get": read,
  "runs.output": read,
  "runs.stop": write,
  "ports.list": read,
  "directories.list": read,
  "cursors.release": read,
  "directories.mkdir": write,
  "workspaces.add": write,
  "workspaces.rename": write,
  "workspaces.remove": write,
  "sessions.list": read,
  "sessions.create": write,
  "sessions.rename": write,
  "sessions.end": write,
  "sessions.recover": write,
  "sessions.redraw": write,
  "sessions.snapshot": { ...read, oversizedSuccess: "failed" },
  "sessions.send": write,
  "sessions.wait": { ...read, oversizedSuccess: "failed" },
  "sessions.resize": write,
  "settings.update": write,
  "shortcuts.put": write,
  "shortcuts.remove": write,
  "files.list": read,
  "files.inspect": read,
  "files.create": write,
  "files.rename": write,
  "files.copy": { ...write, deadline: "none" },
  "files.move": { ...write, deadline: "none" },
  "files.delete": { ...write, deadline: "none" },
  "files.search": { ...read, deadline: "searchTimeout" },
  "repos.discover": read,
  "git.status": read,
  "git.diff": read,
  "git.history": read,
  "git.commitMessage": read,
  "git.commitFiles": read,
  "git.branches": read,
  "git.remotes": read,
  "git.review": read,
  "git.stage": gitWrite,
  "git.unstage": gitWrite,
  "git.discard": gitWrite,
  "git.commit": gitWrite,
  "git.branch.create": gitWrite,
  "git.branch.switch": gitWrite,
  "git.branch.delete": gitWrite,
  "git.fetch": gitWrite,
  "git.pull": gitWrite,
  "git.push": gitWrite,
  "git.continue": gitWrite,
  "git.abort": gitWrite,
} satisfies Record<RpcMethod, RpcTraits> &
  Record<GitWriteMethod, { responseLoss: "unknown"; deadline: "gitWriteTimeout" }>;

export function isRpcMethod(value: string): value is RpcMethod {
  return Object.hasOwn(rpcTraits, value);
}
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];
export type RpcReply<M extends RpcMethod> = Reply<
  RpcMethods[M]["result"],
  RpcMethods[M]["errorResult"]
>;

export type RpcArguments<M extends RpcMethod = RpcMethod> = {
  [K in M]: [method: K, params: RpcParams<K>, signal?: AbortSignal];
}[M];

export type GitWriteMethod = keyof GitWriteMethods;
type GitParams<M extends GitWriteMethod> = Omit<RpcParams<M>, keyof RepoParams>;
export type GitWriteArguments = {
  [M in GitWriteMethod]: [method: M, params: GitParams<M>];
}[GitWriteMethod];
