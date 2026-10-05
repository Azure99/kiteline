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
import { rpc } from "../lib/api";
import { type DraftStore, isDirty } from "../files/drafts";
import { childPath } from "../files/paths";
import type { ChangeSide } from "./selection";
import type { GitActions, GitTarget } from "./actions";
import { GitPathDetails } from "./feedback";

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
  entry: GitEntry & { path: string };
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
            staged && entry.indexStatus === "R" && entry.oldPath
              ? [entry.path, entry.oldPath]
              : [entry.path],
            staged ? "unstage" : "stage",
          )
        }
      >
        {staged ? <Minus /> : <Plus />}
      </IconButton>
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
          {staged && entry.indexStatus === "R" && entry.oldPath && (
            <MenuItem disabled={disabled} onClick={() => onIndex([entry.path], "unstage")}>
              <Minus />
              {t(($) => $.git.unstageNewPath)}
            </MenuItem>
          )}
          {side === "worktree" && (
            <MenuItem
              aria-label={t(($) => $.git.discardNamed, { path: entry.path })}
              disabled={disabled || !discardable(entry)}
              onClick={() => onDiscard([entry.path], "worktree")}
            >
              <Undo2 />
              {t(($) => $.git.discardWorktree)}
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
        paths.some((path) => draft.path === childPath(repoPath, path)),
    );
  return !dirty || window.confirm(i18n.t(($) => $.git.stageDiskConfirm));
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
          <GitPathDetails
            error={error}
            renderBlocked={(path) => (
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
            )}
          />
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
