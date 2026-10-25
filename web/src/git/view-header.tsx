import { ChevronDown, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../components/icon-button";
import { FileIcon } from "../components/file-icon";

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
    <span className="flex min-w-0 flex-1 items-center gap-2" title={title}>
      <FileIcon path={path} />
      <span className={stacked ? "min-w-0 flex-1 py-px" : "flex min-w-0 flex-1 items-center gap-2"}>
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
    </span>
  );
}

export function GitViewHeader({
  view,
  views = ["changes", "history", "branches"],
  open = true,
  onToggle,
  count,
  disabled,
  onView,
  onRefresh,
  onCreateBranch,
}: {
  view: GitView;
  views?: readonly GitView[];
  open?: boolean;
  onToggle?: () => void;
  count?: number;
  disabled: boolean;
  onView(view: GitView): void;
  onRefresh(): void;
  onCreateBranch?: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div
      className={`flex min-h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs max-desk:min-h-11 ${onToggle ? "bg-muted" : ""}`}
    >
      {onToggle && (
        <IconButton
          label={t(($) => (open ? $.common.collapseNamed : $.common.expandNamed), {
            name: t(($) => $.git.views),
          })}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </IconButton>
      )}
      <div role="group" aria-label={t(($) => $.git.views)} className="flex min-w-0 flex-1 gap-1">
        {views.map((id) => (
          <button
            key={id}
            aria-current={view === id ? "true" : undefined}
            onClick={() => onView(id)}
            className={`flex min-h-9 items-center justify-center gap-1 border-b-2 px-1 max-desk:min-h-11 max-desk:min-w-11 ${view === id ? "border-primary text-primary" : "border-transparent"}`}
          >
            {t(($) => $.git[id])}
            {id === "changes" && count !== undefined && (
              <span className="rounded bg-muted px-1">
                {count.toLocaleString(i18n.resolvedLanguage)}
              </span>
            )}
          </button>
        ))}
      </div>
      {onCreateBranch && (
        <IconButton
          label={t(($) => $.git.createBranch)}
          disabled={disabled}
          onClick={onCreateBranch}
        >
          <Plus />
        </IconButton>
      )}
      {open && (
        <IconButton label={t(($) => $.git.refresh)} disabled={disabled} onClick={onRefresh}>
          <RefreshCw />
        </IconButton>
      )}
    </div>
  );
}
