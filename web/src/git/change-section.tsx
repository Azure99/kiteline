import { useTranslation } from "react-i18next";
import { ChevronDown, Circle, Minus, Plus, Undo2 } from "lucide-react";
import type { DiscardScope, GitEntry, GitStatus } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { discardable, RowActions, stageable } from "./change-actions";
import { inSide, type ChangeSelection, type ChangeSide } from "./selection";
import type { DiffTarget } from "./diff-view";
import { GitFilePath } from "./view-header";
import { useGitStatusLabel } from "./status-label";

function submoduleLabel(submodule: NonNullable<GitEntry["submodule"]>) {
  const dirty = submodule.trackedDirty || submodule.untrackedDirty;
  return submodule.commitChanged
    ? dirty
      ? "submodulePointerDirty"
      : "submodulePointer"
    : dirty
      ? "submoduleDirty"
      : "submodule";
}

export function ChangeSection({
  status,
  side,
  selected,
  target,
  disabled,
  onSelect,
  hasUnsavedDraft,
  onIndex,
  onDiscard,
  onFile,
  onTarget,
}: {
  status: GitStatus;
  side: ChangeSide;
  selected: ChangeSelection[];
  target?: DiffTarget;
  disabled: boolean;
  onSelect: (entry: GitEntry, side: ChangeSide) => void;
  hasUnsavedDraft: (path: string) => boolean;
  onIndex: (paths: string[], method: "stage" | "unstage") => void;
  onDiscard: (paths: string[], scope: DiscardScope) => void;
  onFile: (path: string) => void;
  onTarget: (target: DiffTarget) => void;
}) {
  const { t, i18n } = useTranslation();
  const statusLabel = useGitStatusLabel();
  const label = t(($) =>
    side === "conflict"
      ? $.git.conflicts
      : side === "staged"
        ? $.git.stagedChanges
        : $.git.worktreeChanges,
  );
  const entries = status.entries.filter((entry) => inSide(entry, side));
  const chosen = entries.filter(
    (entry): entry is GitEntry & { path: string } =>
      entry.path !== undefined &&
      selected.some((item) => item.path === entry.path && item.side === side),
  );
  if (side === "conflict" && !entries.length) return null;
  return (
    <div>
      <div className="flex items-center gap-2 bg-muted px-3 py-2 text-xs">
        <ChevronDown size={13} />
        {label}
        <span className="ml-auto">
          {(side === "staged" ? status.stagedCount : entries.length).toLocaleString(
            i18n.resolvedLanguage,
          )}
        </span>
        {!!chosen.length && (
          <>
            <IconButton
              label={
                side === "staged" ? t(($) => $.git.unstageSelected) : t(($) => $.git.stageSelected)
              }
              disabled={
                disabled || (side !== "staged" && chosen.some((entry) => !stageable(entry)))
              }
              onClick={() =>
                onIndex(
                  chosen.flatMap((entry) =>
                    side === "staged" && entry.indexStatus === "R" && entry.oldPath
                      ? [entry.path, entry.oldPath]
                      : [entry.path],
                  ),
                  side === "staged" ? "unstage" : "stage",
                )
              }
            >
              {side === "staged" ? <Minus /> : <Plus />}
            </IconButton>
            <IconButton
              label={
                side !== "worktree"
                  ? t(($) => $.git.discardSelectedAll)
                  : t(($) => $.git.discardSelectedWorktree)
              }
              disabled={disabled || chosen.some((entry) => !discardable(entry))}
              onClick={() =>
                onDiscard(
                  chosen.map((entry) => entry.path),
                  side !== "worktree" ? "all" : "worktree",
                )
              }
            >
              <Undo2 />
            </IconButton>
          </>
        )}
      </div>
      {entries.map((entry) => {
        if (entry.path === undefined)
          return (
            <div
              key={`invalid:${entry.pathError}`}
              className="border-b border-border px-3 py-2 text-xs break-all text-muted-foreground"
            >
              <span className="mr-2 font-mono">
                {side === "staged" ? entry.indexStatus : entry.worktreeStatus}
              </span>
              {t(($) => $.git.invalidPath, { path: entry.pathError })}
            </div>
          );
        const description = entry.submodule
          ? t(($) => $.git[submoduleLabel(entry.submodule!)])
          : undefined;
        const code = side === "staged" ? entry.indexStatus : entry.worktreeStatus;
        const stateLabel = entry.conflict ? t(($) => $.git.conflicts) : statusLabel(code);
        const missing = entry.types.worktree === "absent";
        const unsaved = hasUnsavedDraft(entry.path);
        const button = (
          <button
            title={description ? undefined : entry.path}
            aria-label={[
              entry.path,
              label,
              stateLabel,
              description,
              missing && t(($) => $.git.missingDiskFile),
              unsaved && t(($) => $.git.unsavedDraft),
            ]
              .filter(Boolean)
              .join(" · ")}
            disabled={side === "conflict" && missing}
            onClick={() =>
              side === "conflict"
                ? onFile(entry.path)
                : onTarget({ path: entry.path, side: side === "staged" ? "staged" : "worktree" })
            }
            className="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-left text-sm max-desk:min-h-11"
          >
            <GitFilePath path={entry.path} stacked title={description ? "" : entry.path} />
            {unsaved && (
              <span
                className="shrink-0"
                aria-label={t(($) => $.git.unsavedDraft)}
                title={t(($) => $.git.unsavedDraft)}
              >
                <Circle size={7} fill="currentColor" />
              </span>
            )}
          </button>
        );
        return (
          <div
            key={`path:${entry.path}`}
            className={`group flex min-h-8 items-center gap-1 border-b border-border px-2 max-desk:min-h-11 ${target?.path === entry.path && (target.side === side || side === "conflict") ? "bg-primary-soft" : ""}`}
          >
            <label className="flex min-h-8 items-center justify-center max-desk:min-h-11 max-desk:min-w-11">
              <input
                type="checkbox"
                aria-label={t(($) => $.git.selectNamed, { area: label, path: entry.path })}
                checked={selected.some((item) => item.side === side && item.path === entry.path)}
                onChange={() => onSelect(entry, side)}
              />
            </label>
            <span
              className={`w-3 shrink-0 font-mono text-xs ${side === "staged" ? "text-success" : "text-warning"}`}
              title={stateLabel}
              aria-label={stateLabel}
            >
              {side === "staged" ? entry.indexStatus : entry.worktreeStatus}
            </span>
            <RowActions
              button={button}
              entry={entry}
              description={description}
              side={side}
              disabled={disabled}
              onIndex={onIndex}
              onDiscard={onDiscard}
              onFile={() => onFile(entry.path)}
            />
          </div>
        );
      })}
      {!status.totalCount && side === "worktree" && (
        <p className="px-8 py-3 text-xs text-muted-foreground">{t(($) => $.git.noChanges)}</p>
      )}
    </div>
  );
}
