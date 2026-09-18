import { useEffect, useState } from "react";
import { FolderOpen, Minus, MoreHorizontal, Plus, Undo2 } from "lucide-react";
import type { DiscardScope, GitEntry, GitReview } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ApiError, errorMessage, rpc } from "../lib/api";
import { type DraftStore, isDirty } from "../files/drafts";
import type { ChangeSide } from "./selection";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

export function stageable(entry: GitEntry) {
  if (entry.conflict && Object.values(entry.types).includes("gitlink")) return false;
  if (!entry.submodule) return true;
  return !entry.conflict && (entry.submodule.commitChanged || entry.worktreeStatus === "D");
}
export function discardable(entry: GitEntry) {
  return !Object.values(entry.types).includes("gitlink");
}
export function RowActions({
  entry,
  side,
  disabled,
  onIndex,
  onDiscard,
  onFile,
}: {
  entry: GitEntry;
  side: ChangeSide;
  disabled: boolean;
  onIndex: (paths: string[], kind: "stage" | "unstage") => void;
  onDiscard: (paths: string[], scope: DiscardScope) => void;
  onFile: () => void;
}) {
  const staged = side === "staged";
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        label={`${staged ? "取消暂存" : side === "conflict" ? "标记解决" : "暂存"} ${entry.path}`}
        disabled={disabled || (!staged && !stageable(entry))}
        onClick={() =>
          onIndex(
            staged && entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
            staged ? "unstage" : "stage",
          )
        }
      >
        {staged ? <Minus /> : <Plus />}
      </IconButton>
      {side === "worktree" && (
        <IconButton
          label={`丢弃未暂存更改 ${entry.path}`}
          disabled={disabled || !discardable(entry)}
          onClick={() => onDiscard([entry.path], "worktree")}
        >
          <Undo2 />
        </IconButton>
      )}
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon" aria-label={`${entry.path} Git 操作`} />}
        >
          <MoreHorizontal />
        </MenuTrigger>
        <MenuContent>
          <MenuItem onClick={onFile}>
            <FolderOpen />在 Files 打开
          </MenuItem>
          {staged && entry.oldPath && (
            <MenuItem disabled={disabled} onClick={() => onIndex([entry.path], "unstage")}>
              <Minus />
              只取消暂存新路径
            </MenuItem>
          )}
          <MenuItem
            disabled={disabled || !discardable(entry)}
            onClick={() => onDiscard([entry.path], "all")}
          >
            <Undo2 />
            丢弃全部更改
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
export function confirmDiskVersion(
  store: DraftStore,
  target: GitTarget,
  repoPath: string,
  paths: string[],
) {
  const dirty = store
    .snapshot()
    .some(
      (draft) =>
        draft.deviceId === target.deviceId &&
        draft.workspaceId === target.workspaceId &&
        isDirty(draft) &&
        paths.some((path) => draft.path === (repoPath === "." ? path : `${repoPath}/${path}`)),
    );
  return !dirty || window.confirm("所选文件有未保存修改。暂存设备上的磁盘版本？");
}
export function GitFeedback({
  actions,
  target,
  onLocate,
  onTerminal,
}: {
  actions: GitActions;
  target: GitTarget;
  onLocate: (path: string) => void;
  onTerminal: () => void;
}) {
  const value = useGitActivity(actions, target);
  const details =
    value.error instanceof ApiError
      ? (value.error.details as { blockedPaths?: string[]; truncated?: boolean } | undefined)
      : undefined;
  const result = (value.error instanceof ApiError ? value.error.result : value.result) as
    | { changedPaths?: string[]; stdout?: string; stderr?: string; truncated?: boolean }
    | undefined;
  if (!value.request && !value.error && !value.notice) return null;
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <p
          role={value.error ? "alert" : "status"}
          className={`min-w-0 flex-1 break-words ${value.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {value.error
            ? `${value.error instanceof ApiError && value.error.outcome === "partial" ? "部分完成；" : ""}${errorMessage(value.error)}`
            : value.request
              ? `${value.request.label} · ${value.request.phase === "queued" ? "等待执行" : "正在执行"}`
              : value.notice}
        </p>
        {value.request && (
          <Button
            variant="ghost"
            disabled={value.request.cancelling}
            onClick={() => void actions.cancel(target)}
          >
            {value.request.cancelling ? "正在取消" : "取消操作"}
          </Button>
        )}
        {value.error && (
          <Button variant="ghost" onClick={onTerminal}>
            终端
          </Button>
        )}
      </div>
      {!!result?.changedPaths?.length && (
        <div className="mt-1">
          <p>已变更路径</p>
          {result.changedPaths.map((path) => (
            <button
              key={path}
              className="block min-h-9 max-w-full text-left break-all text-primary"
              onClick={() => onLocate(path)}
            >
              {path}
            </button>
          ))}
        </div>
      )}
      {details?.blockedPaths?.map((path) => (
        <button
          key={path}
          className="block min-h-9 max-w-full text-left break-all text-primary"
          onClick={() => onLocate(path)}
        >
          {path}
        </button>
      ))}
      {details?.truncated && <p>更多阻挡项未显示</p>}
      {(result?.stdout || result?.stderr) && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1">Git 输出</summary>
          <pre className="break-words whitespace-pre-wrap">
            {result.stdout}
            {result.stderr}
          </pre>
          {result.truncated && <p>输出仅保留前段</p>}
        </details>
      )}
    </div>
  );
}
export function DiscardDialog({
  target,
  paths,
  scope,
  actions,
  onClose,
  onLocate,
}: {
  target: GitTarget;
  paths: string[];
  scope: DiscardScope;
  actions: GitActions;
  onClose: () => void;
  onLocate: (path: string) => void;
}) {
  const [review, setReview] = useState<GitReview>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void rpc<GitReview>(
      target.deviceId,
      "git.review",
      { workspaceId: target.workspaceId, repoId: target.repoId, paths, scope },
      controller.signal,
    )
      .then(setReview)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      });
    return () => controller.abort();
  }, [target.deviceId, target.workspaceId, target.repoId, paths, scope]);
  const details =
    error instanceof ApiError
      ? (error.details as { blockedPaths?: string[]; truncated?: boolean } | undefined)
      : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{scope === "all" ? "丢弃暂存与未暂存更改" : "丢弃未暂存更改"}</DialogTitle>
        </DialogHeader>
        <div className="scroll-area min-h-0 space-y-2 overflow-auto p-4 text-sm">
          {review
            ? review.summary.map((entry) => (
                <p key={entry.path} className="break-all whitespace-pre-wrap">
                  {entry.action === "delete" ? "删除" : "恢复"} · {entry.path}
                </p>
              ))
            : !error && <p role="status">正在审查</p>}
          {!!error && (
            <p role="alert" className="text-destructive">
              {errorMessage(error)}
            </p>
          )}
          {details?.blockedPaths?.map((path) => (
            <Button
              key={path}
              variant="ghost"
              className="h-auto max-w-full justify-start break-all whitespace-pre-wrap"
              onClick={() => {
                onClose();
                onLocate(path);
              }}
            >
              <FolderOpen />
              {path}
            </Button>
          ))}
          {details?.truncated && <p>更多阻挡项未显示</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={!review}
            onClick={() => {
              if (review) {
                void actions.run(
                  target,
                  "git.discard",
                  { paths: review.paths, scope, reviewToken: review.reviewToken },
                  "丢弃",
                );
                onClose();
              }
            }}
          >
            <Undo2 />
            丢弃
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
