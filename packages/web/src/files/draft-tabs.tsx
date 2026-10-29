import { useTranslation } from "react-i18next";
import { useLayoutEffect, useRef } from "react";
import { Circle, X } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { isDirty, type Draft, type DraftStore } from "./drafts";
import { showDraft } from "./navigation";
import { requestCloseDraft } from "./close-draft";
import { draftLabel } from "./draft-label";

export function DraftTabs({
  store,
  tabs,
  draft,
  hidden,
}: {
  store: DraftStore;
  tabs: Draft[];
  draft?: Draft;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const tabStrip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const reveal = () => {
      const tab = strip.querySelector('[aria-current="true"]')?.parentElement;
      if (!tab || !strip.clientWidth) return;
      const bounds = strip.getBoundingClientRect();
      const current = tab.getBoundingClientRect();
      if (current.left < bounds.left) strip.scrollLeft += current.left - bounds.left;
      else if (current.right > bounds.right) strip.scrollLeft += current.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [draft?.id]);
  return (
    <div
      hidden={hidden}
      ref={tabStrip}
      role="group"
      aria-label={t(($) => $.files.openFiles)}
      className="flex min-h-9 shrink-0 overflow-x-auto border-b border-border bg-muted"
    >
      {tabs.map((item) => (
        <div
          key={item.id}
          className={`flex max-w-64 shrink-0 items-center border-r border-border ${item === draft ? "bg-background" : ""}`}
        >
          <button
            aria-current={item === draft ? "true" : undefined}
            title={draftLabel(item)}
            onClick={() => showDraft(item)}
            className="flex min-h-9 min-w-0 items-center gap-2 px-3 text-xs"
          >
            <span className="truncate">{draftLabel(item).split("/").at(-1)}</span>
            {isDirty(item) && (
              <Circle size={7} fill="currentColor" aria-label={t(($) => $.files.unsaved)} />
            )}
          </button>
          <IconButton
            label={t(($) => $.common.closeNamed, { name: draftLabel(item) })}
            onClick={() => requestCloseDraft(store, item)}
          >
            <X size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
