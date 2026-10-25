import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Files, GitCompareArrows, X } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { MenuItem } from "../components/ui/menu";
import { IconButton } from "../components/icon-button";
import { isDirty } from "../files/drafts";
import { draftLabel } from "../files/draft-label";
import type { useWorkPages } from "./use-work-pages";

export function WorkPages({
  pages,
  hidden,
}: {
  pages: ReturnType<typeof useWorkPages>;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () => {
      const tab = element.querySelector('[aria-current="true"]')?.parentElement;
      if (!tab || !element.clientWidth) return;
      const box = element.getBoundingClientRect(),
        current = tab.getBoundingClientRect();
      if (current.left < box.left) element.scrollLeft += current.left - box.left;
      else if (current.right > box.right) element.scrollLeft += current.right - box.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pages.active]);
  return (
    <div hidden={hidden} className="flex min-h-10 shrink-0 border-b border-border bg-muted">
      <div
        ref={strip}
        className="flex min-w-0 flex-1 overflow-x-auto"
        role="group"
        aria-label={t(($) => $.shell.openWorkPages)}
      >
        {pages.items.map((page) => {
          const draft = pages.draftFor(page);
          const path =
            page.kind === "file" ? (draft ? draftLabel(draft) : page.path) : page.target.path;
          const source =
            page.kind === "file"
              ? t(($) => $.common.files)
              : page.target.side === "commit"
                ? `${page.target.commitOid.slice(0, 8)}${page.target.parentOid ? ` ← ${page.target.parentOid.slice(0, 8)}` : ""}`
                : t(($) => (page.target.side === "staged" ? $.git.index : $.git.worktree));
          const fullPath =
            page.kind === "diff" && page.repoPath !== "." ? `${page.repoPath}/${path}` : path;
          const title = `${fullPath} · ${source}`;
          return (
            <div
              key={page.id}
              className={`flex max-w-72 shrink-0 items-center border-r border-border ${pages.active === page.id ? "bg-background" : ""}`}
            >
              <ContextMenu>
                <ContextMenuTrigger
                  render={
                    <button
                      title={title}
                      aria-label={
                        draft && isDirty(draft) ? `${title} · ${t(($) => $.files.unsaved)}` : title
                      }
                      aria-current={pages.active === page.id ? "true" : undefined}
                      onClick={() => pages.select(page)}
                      className="flex min-h-9 min-w-0 items-center gap-2 px-3 text-sm max-desk:min-h-11"
                    >
                      {page.kind === "diff" ? (
                        <GitCompareArrows size={14} className="shrink-0" />
                      ) : (
                        <Files size={14} className="shrink-0" />
                      )}
                      <span className="truncate">{path.split("/").at(-1)}</span>
                      {draft && isDirty(draft) && (
                        <Circle
                          size={7}
                          fill="currentColor"
                          className="shrink-0"
                          aria-label={t(($) => $.files.unsaved)}
                        />
                      )}
                    </button>
                  }
                />
                <ContextMenuContent>
                  <p className="max-w-72 px-2 py-1 text-xs break-all text-muted-foreground">
                    {title}
                  </p>
                  <MenuItem onClick={() => pages.select(page)}>{t(($) => $.common.open)}</MenuItem>
                  <MenuItem onClick={() => pages.close(page)}>
                    <X />
                    {t(($) => $.common.close)}
                  </MenuItem>
                </ContextMenuContent>
              </ContextMenu>

              <IconButton
                label={t(($) => $.common.closeNamed, { name: title })}
                onClick={() => pages.close(page)}
              >
                <X size={13} />
              </IconButton>
            </div>
          );
        })}
      </div>
    </div>
  );
}
