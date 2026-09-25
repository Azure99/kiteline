import { ErrorNotice } from "../components/error-notice";
import { i18n } from "../i18n";
import { useTranslation } from "react-i18next";
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
import { ApiError, rpc } from "../lib/api";
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
  const { t } = useTranslation();

  const staged = side === "staged";
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        label={t(
          ($) =>
            staged
              ? $.git.unstageNamed
              : side === "conflict"
                ? $.git.resolveNamed
                : $.git.stageNamed,
          { path: entry.path },
        )}
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
          label={t(($) => $.git.discardNamed, { path: entry.path })}
          disabled={disabled || !discardable(entry)}
          onClick={() => onDiscard([entry.path], "worktree")}
        >
          <Undo2 />
        </IconButton>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(($) => $.git.actionsNamed, { path: entry.path })}
            />
          }
        >
          <MoreHorizontal />
        </MenuTrigger>
        <MenuContent>
          <p className="max-w-72 px-2 py-1 text-xs break-all text-muted-foreground">{entry.path}</p>
          <MenuItem onClick={onFile}>
            <FolderOpen />
            {t(($) => $.git.openFiles)}
          </MenuItem>
          {staged && entry.oldPath && (
            <MenuItem disabled={disabled} onClick={() => onIndex([entry.path], "unstage")}>
              <Minus />
              {t(($) => $.git.unstageNewPath)}
            </MenuItem>
          )}
          <MenuItem
            disabled={disabled || !discardable(entry)}
            onClick={() => onDiscard([entry.path], "all")}
          >
            <Undo2 />
            {t(($) => $.git.discardAll)}
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
  return !dirty || window.confirm(i18n.t(($) => $.git.stageDiskConfirm));
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
  const { t } = useTranslation();

  const value = useGitActivity(actions, target);
  const details =
    value.error instanceof ApiError
      ? (value.error.details as { blockedPaths?: string[]; truncated?: boolean } | undefined)
      : undefined;
  const result = (value.error instanceof ApiError ? value.error.result : value.result) as
    | { changedPaths?: string[]; stdout?: string; stderr?: string; truncated?: boolean }
    | undefined;
  const actionNames = {
    "git.stage": t(($) => $.git.stage),
    "git.unstage": t(($) => $.git.unstage),
    "git.commit": t(($) => $.git.commit),
    "git.discard": t(($) => $.git.discard),
    "git.branch.create": t(($) => $.git.createBranch),
    "git.branch.switch": t(($) => $.git.switchBranch),
    "git.branch.delete": t(($) => $.git.deleteBranch),
    "git.continue": t(($) => $.git.continue),
    "git.abort": t(($) => $.git.abort),
    "git.fetch": "Fetch",
    "git.pull": "Pull",
    "git.push": "Push",
  };
  if (!value.request && !value.error && !value.completed) return null;
  if (
    !value.request &&
    !value.error &&
    (value.completed === "git.stage" || value.completed === "git.unstage")
  )
    return null;
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role={value.error ? "alert" : "status"}
          className={`min-w-0 flex-1 break-words ${value.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {value.error ? (
            <ErrorNotice error={value.error} />
          ) : value.request ? (
            t(
              ($) => (value.request!.phase === "queued" ? $.git.actionQueued : $.git.actionRunning),
              { action: actionNames[value.request.method] },
            )
          ) : (
            value.completed &&
            t(($) => $.git.actionCompleted, { action: actionNames[value.completed] })
          )}
        </div>
        {value.request && (
          <Button
            variant="ghost"
            disabled={value.request.cancelling}
            onClick={() => void actions.cancel(target)}
          >
            {value.request.cancelling
              ? t(($) => $.common.cancelling)
              : t(($) => $.common.cancelOperation)}
          </Button>
        )}
        {!!value.error && (
          <Button variant="ghost" onClick={onTerminal}>
            {t(($) => $.common.terminal)}
          </Button>
        )}
      </div>
      {!!result?.changedPaths?.length && (
        <div className="mt-1">
          <p>{t(($) => $.git.changedPaths)}</p>
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
      {details?.truncated && <p>{t(($) => $.git.moreBlockedPaths)}</p>}
      {(result?.stdout || result?.stderr) && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1">{t(($) => $.git.output)}</summary>
          <pre className="break-words whitespace-pre-wrap">
            {result.stdout}
            {result.stderr}
          </pre>
          {result.truncated && <p>{t(($) => $.git.outputTruncated)}</p>}
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
  const { t } = useTranslation();

  const [review, setReview] = useState<GitReview>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void rpc(
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
          <DialogTitle>
            {scope === "all"
              ? t(($) => $.git.discardStagedWorktree)
              : t(($) => $.git.discardWorktree)}
          </DialogTitle>
        </DialogHeader>
        <div className="scroll-area min-h-0 space-y-2 overflow-auto p-4 text-sm">
          {review
            ? review.summary.map((entry) => (
                <p key={entry.path} className="break-all whitespace-pre-wrap">
                  {entry.action === "delete" ? t(($) => $.common.delete) : t(($) => $.git.restore)}{" "}
                  · {entry.path}
                </p>
              ))
            : !error && <p role="status">{t(($) => $.git.reviewing)}</p>}
          {!!error && (
            <div role="alert" className="text-destructive">
              <ErrorNotice error={error} />
            </div>
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
          {details?.truncated && <p>{t(($) => $.git.moreBlockedPaths)}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t(($) => $.common.cancel)}
          </Button>
          <Button
            variant="destructive"
            disabled={!review}
            onClick={() => {
              if (review) {
                void actions.run(target, "git.discard", {
                  paths: review.paths,
                  scope,
                  reviewToken: review.reviewToken,
                });
                onClose();
              }
            }}
          >
            <Undo2 />
            {t(($) => $.git.discard)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
