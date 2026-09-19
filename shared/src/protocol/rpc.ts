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

type Contract<P, R> = { params: P; result: R };
type WorkspaceParams = { workspaceId: string };
type FileParams = WorkspaceParams & { path: string };
type RepoParams = WorkspaceParams & { repoId: string };
type SessionParams = WorkspaceParams & { sessionId: string };
type GitOutput = { stdout: string; stderr: string; truncated: boolean };
type GitPaths = RepoParams & { paths: string[] };
type GitFinish = RepoParams & { expectedOperation: { kind: GitOperation["kind"]; token: string } };
type BranchTarget = RepoParams & { name: string; refOid: string };
type FileResults = { items: FileItemResult[] };

export interface RpcMethods {
  "ports.list": Contract<Record<string, never>, ListeningPorts>;
  "directories.list": Contract<{ absolutePath: string; cursor?: string }, DirectoryListing>;
  "directories.mkdir": Contract<{ absolutePath: string }, { path: string }>;
  "workspaces.add": Contract<{ absolutePath: string; name?: string }, Workspace>;
  "workspaces.rename": Contract<WorkspaceParams & { name: string }, Workspace>;
  "workspaces.remove": Contract<WorkspaceParams, { removed: boolean }>;
  "sessions.list": Contract<{ workspaceId?: string }, { sessions: Session[] }>;
  "sessions.create": Contract<WorkspaceParams & { name?: string; shortcutId?: string }, Session>;
  "sessions.rename": Contract<SessionParams & { name: string }, Session>;
  "sessions.end": Contract<{ workspaceId?: string; sessionId: string }, { ended: boolean }>;
  "sessions.recover": Contract<SessionParams, Session>;
  "sessions.redraw": Contract<SessionParams, Session>;
  "settings.update": Contract<{ historyLines: number }, Metadata["settings"]>;
  "shortcuts.put": Contract<{ id?: string; name: string; command: string }, Shortcut>;
  "shortcuts.remove": Contract<{ id: string }, { removed: boolean }>;
  "files.list": Contract<FileParams & { cursor?: string }, FileListing>;
  "files.inspect": Contract<FileParams & { suggestCopyName?: boolean }, FileInspection>;
  "files.create": Contract<FileParams & { kind: "file" | "directory" }, Entry>;
  "files.rename": Contract<FileParams & { newName: string }, { from: string; to: string }>;
  "files.copy": Contract<WorkspaceParams & { items: CopyItem[] }, FileResults>;
  "files.move": Contract<WorkspaceParams & { items: CopyItem[] }, FileResults>;
  "files.delete": Contract<WorkspaceParams & { paths: string[] }, FileResults>;
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
  "git.commitFiles": Contract<
    RepoParams & { commitOid: string; parentOid?: string; cursor?: string },
    CommitFiles
  >;
  "git.branches": Contract<RepoParams, { branches: Branch[] }>;
  "git.remotes": Contract<RepoParams, GitRemotes>;
  "git.review": Contract<GitPaths & { scope: DiscardScope }, GitReview>;
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

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];
export type RpcRequest<M extends RpcMethod = RpcMethod> = {
  [K in M]: { method: K; params: RpcParams<K> };
}[M];
export type RpcReply<M extends RpcMethod> = Reply<
  RpcResult<M>,
  M extends "files.copy" | "files.move" | "files.delete" ? FileResults : unknown
>;

export type RpcArguments<M extends RpcMethod = RpcMethod> = {
  [K in M]: [method: K, params: RpcParams<K>, signal?: AbortSignal];
}[M];

export type GitWriteMethod =
  | "git.stage"
  | "git.unstage"
  | "git.discard"
  | "git.commit"
  | "git.branch.create"
  | "git.branch.switch"
  | "git.branch.delete"
  | "git.fetch"
  | "git.pull"
  | "git.push"
  | "git.continue"
  | "git.abort";
type GitParams<M extends GitWriteMethod> = Omit<RpcParams<M>, keyof RepoParams>;
export type GitWriteArguments = {
  [M in GitWriteMethod]: [method: M, params: GitParams<M>, label: string];
}[GitWriteMethod];
