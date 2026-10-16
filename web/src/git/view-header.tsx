import { ArrowLeft, FilePenLine, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ViewType } from "react-diff-view";
import { IconButton } from "../components/icon-button";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/menu";
import { useMobile } from "../lib/use-mobile";
import type { DiffTarget } from "./diff-view";

export type GitView = "changes" | "history" | "branches";

export function GitFilePath({
  path,
  stacked = false,
  title = path,
}: {
  path: string;
  stacked?: boolean;
  title?: string;
}) {
  const split = path.lastIndexOf("/");
  return (
    <span
      className={stacked ? "min-w-0 flex-1 py-px" : "flex min-w-0 flex-1 items-center gap-2"}
      title={title}
    >
      <span className={stacked ? "block truncate leading-4" : "truncate"}>
        {path.slice(split + 1)}
      </span>
      {split >= 0 && (
        <span
          className={
            stacked
              ? "block truncate text-[11px] leading-[14px] text-muted-foreground"
              : "truncate text-muted-foreground"
          }
        >
          {path.slice(0, split)}
        </span>
      )}
    </span>
  );
}

export function GitViewHeader({
  view,
  count,
  target,
  disabled,
  onView,
  onBack,
  onRefresh,
  onFile,
  onCreateBranch,
  diffView,
  onDiffView,
}: {
  view: GitView;
  diffView: ViewType;
  onDiffView(view: ViewType): void;
  count?: number;
  target?: DiffTarget;
  disabled: boolean;
  onView(view: GitView): void;
  onBack?(): void;
  onRefresh(): void;
  onFile(path: string): void;
  onCreateBranch?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const mobile = useMobile();
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs max-desk:min-h-11">
      {(!mobile || !target) && (
        <div
          role="group"
          aria-label={t(($) => $.git.views)}
          className="flex shrink-0 gap-1 desk:gap-3"
        >
          {(["changes", "history", "branches"] as const).map((id) => (
            <button
              key={id}
              aria-current={view === id ? "true" : undefined}
              onClick={() => onView(id)}
              className={`flex min-h-9 items-center justify-center gap-2 border-b-2 px-1 max-desk:min-h-11 max-desk:min-w-11 ${view === id ? "border-primary text-primary" : "border-transparent"}`}
            >
              {t(($) => $.git[id])}
              {id === "changes" && count !== undefined && (
                <span className="rounded bg-muted px-1.5">
                  {count.toLocaleString(i18n.resolvedLanguage)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {target ? (
        <>
          <IconButton
            label={t(($) => (target.side === "commit" ? $.git.backCommitFiles : $.git.backChanges))}
            onClick={onBack}
          >
            <ArrowLeft />
          </IconButton>
          <GitFilePath path={target.path} />
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t(($) =>
              target.side === "staged"
                ? $.git.index
                : target.side === "commit"
                  ? $.git.commit
                  : $.git.worktree,
            )}
          </span>
          <Menu>
            <MenuTrigger
              render={<IconButton label={t(($) => $.git.actionsNamed, { path: target.path })} />}
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent>
              <p className="max-w-72 px-2 py-1 text-xs break-all text-muted-foreground">
                {target.path}
              </p>
              <MenuItem onClick={() => onFile(target.path)}>
                <FilePenLine />
                {t(($) => $.git.openFiles)}
              </MenuItem>
              {mobile && target.side === "commit" && (
                <MenuRadioGroup value={view} onValueChange={(value) => onView(value as GitView)}>
                  {(["changes", "history", "branches"] as const).map((id) => (
                    <MenuRadioItem key={id} value={id} closeOnClick>
                      {t(($) => $.git[id])}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              )}
            </MenuContent>
          </Menu>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {!mobile && target && (
        <div className="flex shrink-0 gap-1" role="group" aria-label={t(($) => $.git.diffLayout)}>
          {(["unified", "split"] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={diffView === mode}
              onClick={() => onDiffView(mode)}
              className={`min-h-8 rounded px-2 ${diffView === mode ? "bg-primary-soft text-primary" : "text-muted-foreground"}`}
            >
              {t(($) => $.git[mode])}
            </button>
          ))}
        </div>
      )}
      {onCreateBranch && (
        <IconButton
          label={t(($) => $.git.createBranch)}
          disabled={disabled}
          onClick={onCreateBranch}
        >
          <Plus />
        </IconButton>
      )}
      <IconButton label={t(($) => $.git.refresh)} disabled={disabled} onClick={onRefresh}>
        <RefreshCw />
      </IconButton>
    </div>
  );
}
