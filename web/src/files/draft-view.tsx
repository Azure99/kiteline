import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Circle,
  Code,
  Copy,
  Download,
  Eye,
  FileOutput,
  Fullscreen,
  Minimize,
  RefreshCw,
  Save,
  Scan,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";
import { deferredView } from "../components/deferred-view";
import { ApiError } from "../lib/api";
import { useCopyFeedback } from "../lib/use-copy-feedback";
import {
  draftError,
  isDirty,
  useDrafts,
  useDraftVersion,
  type Draft,
  type DraftStore,
} from "./drafts";
import { requestCloseDraft, showDraft } from "./navigation";
import { TextEditor } from "./text-editor";
import { formatBytes } from "./format";
import { downloadFile, type DiskText } from "./content";
import type { useTerminalFocus } from "../terminal/use-terminal-focus";

const MarkdownPreview = deferredView(async () => ({
  default: (await import("./markdown-preview")).MarkdownPreview,
}));

export function DraftView({
  store,
  draft,
  unavailable,
  focusMode,
}: {
  focusMode?: ReturnType<typeof useTerminalFocus>;
  store: DraftStore;
  draft: Draft;
  unavailable?: string;
}) {
  const { t } = useTranslation();

  const all = useDrafts(store);
  // Editing updates this draft without notifying the entire open-files list.
  useDraftVersion(store, draft);
  const busy = draft.operation?.kind;
  const markdown = /\.(md|markdown)$/i.test(draft.path);
  const [preview, setPreview] = useState(false);
  const previewElement = useRef<HTMLElement>(null);
  const previewPosition = useRef<{ line: number; offset: number }>(undefined);
  function togglePreview() {
    const article = previewElement.current;
    if (preview && article) {
      const viewport = article.getBoundingClientRect();
      let nearest: HTMLElement | undefined;
      let distance = Infinity;
      for (const block of article.querySelectorAll<HTMLElement>("[data-source-line]")) {
        const bounds = block.getBoundingClientRect();
        const gap = Math.abs(bounds.top - viewport.top);
        if (bounds.bottom > viewport.top && bounds.top < viewport.bottom && gap < distance) {
          nearest = block;
          distance = gap;
        }
      }
      if (nearest) {
        const line = Number(nearest.dataset.sourceLine);
        previewPosition.current = {
          line,
          offset: nearest.getBoundingClientRect().top - viewport.top,
        };
        draft.location = { line };
      }
    }
    setPreview(!preview);
  }
  const [disk, setDisk] = useState<DiskText>();
  const [saveAs, setSaveAs] = useState(false);
  const [path, setPath] = useState(draft.path);
  const [error, setError] = useState<unknown>();
  const { copied, error: copyError, copy } = useCopyFeedback();
  const generation = useRef(0);
  const tabStrip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const reveal = () => {
      const tab = strip.querySelector('[aria-selected="true"]')?.parentElement;
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
  }, [draft.id]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function closeSaveAs() {
    generation.current++;
    setSaveAs(false);
  }
  const tabs = all.filter(
    (item) => item.deviceId === draft.deviceId && item.workspaceId === draft.workspaceId,
  );
  async function save(revision?: string, target = draft.path) {
    if (await store.save(draft, target, revision ?? draft.revision)) setDisk(undefined);
  }
  async function check() {
    const current = await store.check(draft);
    if (current && (draft.unknownSave !== undefined || current.meta.revision !== draft.revision))
      setDisk(current);
  }
  if (!store.has(draft))
    return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.files.closed)}</div>;
  return (
    <>
      <div
        hidden={focusMode?.active}
        ref={tabStrip}
        role="tablist"
        aria-label={t(($) => $.files.openFiles)}
        className="flex min-h-9 shrink-0 overflow-x-auto border-b border-border bg-muted/40"
      >
        {tabs.map((item) => (
          <div
            key={item.id}
            className={`flex max-w-64 shrink-0 items-center border-r border-border ${item === draft ? "bg-background" : ""}`}
          >
            <button
              role="tab"
              aria-selected={item === draft}
              title={item.path}
              onClick={() => showDraft(item)}
              className="flex min-h-9 min-w-0 items-center gap-2 px-3 text-xs"
            >
              <span className="truncate">{item.path.split("/").at(-1)}</span>
              {isDirty(item) && (
                <Circle size={7} fill="currentColor" aria-label={t(($) => $.files.unsaved)} />
              )}
            </button>
            <IconButton
              label={t(($) => $.common.closeNamed, { name: item.path })}
              onClick={() => requestCloseDraft(store, item)}
            >
              <X size={13} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-3 max-sm:flex-wrap">
        <span
          className="min-w-0 flex-1 truncate text-xs max-sm:basis-full max-sm:pt-1"
          title={`${draft.deviceName} / ${draft.workspaceName}\n${draft.resolvedPath ?? draft.path}`}
        >
          {draft.path}
        </span>
        {markdown && (
          <IconButton
            label={preview ? t(($) => $.files.editSource) : t(($) => $.files.previewMarkdown)}
            onClick={togglePreview}
          >
            {preview ? <Code /> : <Eye />}
          </IconButton>
        )}
        <IconButton
          label={t(($) => $.files.downloadFile)}
          disabled={!!unavailable}
          onClick={() => downloadFile(draft)}
        >
          <Download />
        </IconButton>
        <IconButton
          label={t(($) => $.files.copyText)}
          disabled={!draft.state}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void copy(draft.state!.doc.toString(), draft.id)}
        >
          <Copy />
        </IconButton>
        <IconButton
          label={t(($) => $.files.checkDisk)}
          disabled={!!busy || !!unavailable}
          onClick={() => void check()}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label={t(($) => $.files.saveAs)}
          disabled={!draft.state || !!busy || !!unavailable}
          onClick={() => {
            setPath(draft.path);
            setError(undefined);
            setSaveAs(true);
          }}
        >
          <FileOutput />
        </IconButton>
        <IconButton
          label={t(($) => $.files.saveFile)}
          disabled={!store.canSave(draft) || !!unavailable}
          onClick={() => void save()}
        >
          <Save />
        </IconButton>
        {focusMode && (
          <IconButton
            label={
              focusMode.next === "enterFocus"
                ? t(($) => $.files.enterFocus)
                : t(($) => $.terminal[focusMode.next])
            }
            onClick={focusMode.toggle}
          >
            {focusMode.next === "exitFocus" ? (
              <Minimize />
            ) : focusMode.next === "enterFullscreen" ? (
              <Fullscreen />
            ) : (
              <Scan />
            )}
          </IconButton>
        )}
      </div>
      {focusMode?.error && (
        <div role="alert" className="shrink-0 text-destructive">
          {t(($) => $.terminal[focusMode.error!])}
        </div>
      )}
      {(unavailable ||
        store.overLimit(draft) ||
        draft.notice ||
        draft.diskChanged ||
        draftError(draft) ||
        copyError ||
        draft.format.mixedLineEndings) && (
        <div className="shrink-0 space-y-1 border-b border-border px-3 py-2 text-xs">
          {unavailable && <p role="status">{unavailable}</p>}
          {store.overLimit(draft) && <p role="status">{t(($) => $.files.shrinkToSave)}</p>}
          {draft.format.mixedLineEndings && (
            <p className="text-muted-foreground">
              {t(($) => $.files.mixedEol, { format: draft.format.lineEnding.toUpperCase() })}
            </p>
          )}
          {draft.notice && <p role="status">{t(($) => $.files[draft.notice!])}</p>}
          {draft.diskChanged && <p role="status">{t(($) => $.files.diskChanged)}</p>}
          {draftError(draft) && (
            <div role="alert" className="break-words text-destructive">
              <ErrorNotice error={draft.error ?? draft.observationError} />
            </div>
          )}
          {copyError && (
            <div role="alert" className="break-words text-destructive">
              <ErrorNotice error={copyError.error} />
            </div>
          )}
          {!!(
            draft.error instanceof ApiError &&
            (draft.error.code === "conflict" || draft.error.outcome === "unknown")
          ) && (
            <Button
              variant="outline"
              disabled={!!busy || !!unavailable}
              onClick={() => void check()}
            >
              {t(($) => $.files.checkDisk)}
            </Button>
          )}
        </div>
      )}
      {draft.state && markdown && preview ? (
        <MarkdownPreview
          target={draft}
          text={draft.state.doc.toString()}
          containerRef={previewElement}
          position={previewPosition.current}
        />
      ) : draft.state ? (
        <TextEditor
          key={draft.id}
          {...{ draft, store }}
          onSave={() => {
            if (!unavailable) void save();
          }}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
          {busy ? t(($) => $.common.reading) : t(($) => $.files.noText)}
          {!busy && (
            <Button
              variant="outline"
              disabled={!!unavailable}
              onClick={() => void store.load(draft)}
            >
              <RefreshCw />
              {t(($) => $.common.retry)}
            </Button>
          )}
        </div>
      )}
      <div className="flex min-h-6 shrink-0 flex-wrap items-center justify-between gap-x-3 border-t border-border px-3 text-[11px] text-muted-foreground">
        <span className="flex gap-3">
          <span>
            {busy === "saving"
              ? t(($) => $.files.saving)
              : busy === "checking"
                ? t(($) => $.files.checking)
                : isDirty(draft)
                  ? t(($) => $.files.unsaved)
                  : draft.state
                    ? t(($) => $.common.saved)
                    : ""}
          </span>
          <span role="status">{copied === draft.id ? t(($) => $.common.copied) : ""}</span>
        </span>
        {draft.state && (
          <span>
            {formatBytes(draft.bytes)} · UTF-8{draft.format.bom ? " BOM" : ""} ·{" "}
            {draft.format.lineEnding.toUpperCase()}
          </span>
        )}
      </div>
      <Dialog
        open={!!disk}
        onOpenChange={(open) => {
          if (!open) setDisk(undefined);
        }}
      >
        {disk && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(($) => $.files.diskChanged)}</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 space-y-3 overflow-auto p-4">
              <p className="break-all text-xs">{disk.target.path}</p>
              <Textarea
                aria-label={t(($) => $.files.diskText)}
                value={disk.text}
                readOnly
                rows={12}
                className="font-mono text-xs"
              />
              {!!error && (
                <div role="alert" className="text-sm text-destructive">
                  <ErrorNotice error={error} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDisk(undefined)}>
                {t(($) => $.common.cancel)}
              </Button>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => {
                  if (isDirty(draft) && !window.confirm(t(($) => $.files.discardLoad))) return;
                  try {
                    store.adopt(draft, disk);
                    setDisk(undefined);
                  } catch (reason) {
                    setError(reason);
                  }
                }}
              >
                {t(($) => $.files.loadDisk)}
              </Button>
              <Button
                disabled={!store.canSave(draft) || !!unavailable}
                onClick={() => void save(disk.meta.revision, disk.target.path)}
              >
                {t(($) => $.files.overwriteVersion)}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={saveAs}
        onOpenChange={(open) => {
          if (!open) closeSaveAs();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.files.saveAs)}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError(undefined);
              const submitted = ++generation.current;
              void store.save(draft, path, null).then((saved) => {
                if (submitted !== generation.current || !store.has(draft)) return;
                if (saved) {
                  closeSaveAs();
                } else
                  setError(
                    draft.error ??
                      draft.observationError ??
                      new Error("The file could not be saved"),
                  );
              });
            }}
            className="flex min-h-0 flex-col"
          >
            <div className="space-y-3 overflow-auto p-4">
              <Textarea
                aria-label={t(($) => $.files.savePath)}
                rows={2}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              {!!error && (
                <div role="alert" className="text-sm text-destructive">
                  <ErrorNotice error={error} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeSaveAs}>
                {t(($) => $.common.cancel)}
              </Button>
              <Button type="submit" disabled={!store.canSave(draft)}>
                {t(($) => $.files.saveCopy)}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
