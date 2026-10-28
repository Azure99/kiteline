import { ErrorNotice } from "../components/error-notice";
import { i18n } from "../i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useState, type ReactElement } from "react";
import { Check, FolderOpen, Minus, MoreHorizontal, Plus, Trash2, Undo2 } from "lucide-react";
import {
  indexRenameSource,
  isUntracked,
  type DiscardScope,
  type GitEntry,
  type GitReview,
} from "@kiteline/shared/protocol";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "../components/ui/tooltip";
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
import { cn } from "../lib/utils";
import type { DraftStore } from "../files/drafts";
import { hasUnsavedDraft } from "./drafts";
import { defaultIndexPaths, type ChangeSide } from "./selection";
import type { GitTarget } from "./actions";
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
  button,
  entry,
  description,
  side,
  disabled,
  onIndex,
  onDiscard,
  onFile,
}: {
  button: ReactElement;
  entry: GitEntry & { path: string };
  description?: string;
  side: ChangeSide;
  disabled: boolean;
  onIndex: (paths: string[], kind: "stage" | "unstage") => void;
  onDiscard: (paths: string[], scope: DiscardScope) => void;
  onFile: () => void;
}) {
  const { t } = useTranslation();

  const staged = side === "staged";
  const indexDisabled = disabled || (!staged && !stageable(entry));
  const indexLabel = t(
    ($) =>
      staged ? $.git.unstageNamed : side === "conflict" ? $.git.resolveNamed : $.git.stageNamed,
    { path: entry.path },
  );
  const index = () => onIndex(defaultIndexPaths(entry, side), staged ? "unstage" : "stage");
  const details = (
    <>
      <p className="max-w-72 px-2 py-1 text-xs break-all text-muted-foreground">{entry.path}</p>
      {entry.oldPath && (
        <p className="max-w-72 px-2 py-1 text-xs break-all text-muted-foreground">
          {t(($) => $.git.previousPath, { path: entry.oldPath })}
        </p>
      )}
      {entry.types.worktree === "absent" && (
        <p className="max-w-72 px-2 py-1 text-xs text-muted-foreground">
          {t(($) => $.git.missingDiskFile)}
        </p>
      )}
      {description && (
        <p className="max-w-72 px-2 py-1 text-xs text-muted-foreground">{description}</p>
      )}
    </>
  );
  const items = (
    <>
      <MenuItem disabled={entry.types.worktree === "absent"} onClick={onFile}>
        <FolderOpen />
        {t(($) => $.git.openFiles)}
      </MenuItem>
      {staged && indexRenameSource(entry) && (
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
      {!isUntracked(entry) && (
        <MenuItem
          disabled={disabled || !discardable(entry)}
          onClick={() => onDiscard([entry.path], "all")}
        >
          <Undo2 />
          {t(($) => $.git.discardAll)}
        </MenuItem>
      )}
    </>
  );
  const trigger = <ContextMenuTrigger render={button} />;
  return (
    <>
      <ContextMenu>
        {description ? (
          <Tooltip>
            <TooltipTrigger render={trigger} />
            <TooltipContent>
              <p className="break-all">{entry.path}</p>
              <p>{description}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}
        <ContextMenuContent>
          {details}
          <MenuItem aria-label={indexLabel} disabled={indexDisabled} onClick={index}>
            {staged ? <Minus /> : side === "conflict" ? <Check /> : <Plus />}
            {t(($) => (staged ? $.git.unstage : side === "conflict" ? $.git.resolve : $.git.stage))}
          </MenuItem>
          {items}
        </ContextMenuContent>
      </ContextMenu>
      <div className="flex shrink-0 items-center">
        <IconButton label={indexLabel} disabled={indexDisabled} onClick={index}>
          {staged ? <Minus /> : side === "conflict" ? <Check /> : <Plus />}
        </IconButton>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="row-more"
                aria-label={t(($) => $.git.actionsNamed, { path: entry.path })}
              />
            }
          >
            <MoreHorizontal />
          </MenuTrigger>
          <MenuContent>
            {details}
            {items}
          </MenuContent>
        </Menu>
      </div>
    </>
  );
}

export function confirmDiskVersion(
  store: DraftStore,
  target: GitTarget,
  repoPath: string,
  paths: string[],
) {
  const dirty = hasUnsavedDraft(store.snapshot(), target, repoPath, paths);
  return !dirty || window.confirm(i18n.t(($) => $.git.stageDiskConfirm));
}
export function DiscardDialog({
  target,
  paths,
  scope,
  onDiscard,
  onClose,
  onLocate,
}: {
  target: GitTarget;
  paths: string[];
  scope: DiscardScope;
  onDiscard: (review: GitReview) => void;
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
        <div className="scroll-area min-h-0 space-y-4 overflow-auto p-4 text-sm">
          {review ? (
            <DiscardSummary summary={review.summary} scope={scope} />
          ) : (
            !error && <p role="status">{t(($) => $.git.reviewing)}</p>
          )}
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
                onDiscard(review);
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

export function DiscardSummary({
  summary,
  scope,
}: {
  summary: GitReview["summary"];
  scope: DiscardScope;
}) {
  const { t } = useTranslation();
  return (["delete", "restore"] as const).map((action) => {
    const entries = summary.filter((entry) => entry.action === action);
    const count = entries.length;
    if (!count) return null;
    return (
      <section key={action} className="space-y-2">
        <h3
          className={cn(
            "flex items-center gap-2 font-medium",
            action === "delete" && "text-destructive",
          )}
        >
          {action === "delete" ? (
            <Trash2 size={16} className="shrink-0" />
          ) : (
            <Undo2 size={16} className="shrink-0 text-muted-foreground" />
          )}
          {action === "delete"
            ? t(($) => $.git.discardDeletes, { count })
            : scope === "all"
              ? t(($) => $.git.discardRestoresHead, { count })
              : t(($) => $.git.discardRestoresIndex, { count })}
        </h3>
        {action === "delete" && (
          <p className="text-xs text-destructive">{t(($) => $.git.discardDeleteHint)}</p>
        )}
        <ul className="space-y-1 pl-6">
          {entries.map((entry) => (
            <li key={entry.path} className="break-all whitespace-pre-wrap">
              {entry.path}
            </li>
          ))}
        </ul>
      </section>
    );
  });
}
