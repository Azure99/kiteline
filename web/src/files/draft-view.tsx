import { ErrorNotice } from "../components/error-notice";
import type { AgentEnvironment } from "@kiteline/shared/protocol";
import { useTranslation } from "react-i18next";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  Code,
  Copy,
  Download,
  Eye,
  FileOutput,
  Fullscreen,
  Minimize,
  Quote,
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
import { DraftTabs } from "./draft-tabs";
import { draftLabel } from "./draft-label";
import { codeLineReference } from "./code-line-reference";
import { SaveDraftDialog } from "./save-draft-dialog";
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
  targetOS,
  unavailable,
  focusMode,
  editorVisible = true,
  htmlPreviewVisible = true,
}: {
  focusMode?: ReturnType<typeof useTerminalFocus>;
  editorVisible?: boolean;
  htmlPreviewVisible?: boolean;
  store: DraftStore;
  draft: Draft;
  targetOS?: AgentEnvironment["os"];
  unavailable?: string;
}) {
  const { t } = useTranslation();

  const all = useDrafts(store);
  // Editing updates this draft without notifying the entire open-files list.
  useDraftVersion(store, draft);
  const busy = draft.operation?.kind;
  const canCheckDisk = !!(draft.path || draft.unknownSave);
  const previewType = /\.html?$/i.test(draft.path)
    ? "html"
    : /\.(md|markdown)$/i.test(draft.path)
      ? "markdown"
      : undefined;
  const [preview, setPreview] = useState<typeof previewType>();
  if (preview && preview !== previewType) setPreview(undefined);
  const previewElement = useRef<HTMLElement>(null);
  const previewPosition = useRef<{ line: number; offset: number }>(undefined);
  const rememberPreviewPosition = useCallback(() => {
    const article = previewElement.current;
    if (preview === "markdown" && article) {
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
        return line;
      }
    }
  }, [preview]);
  function togglePreview() {
    const line = rememberPreviewPosition();
    if (line) draft.location = { line };
    setPreview(preview ? undefined : previewType);
  }
  useLayoutEffect(() => {
    if (preview && draft.location) {
      rememberPreviewPosition();
      setPreview(undefined);
    }
  }, [preview, draft.location, rememberPreviewPosition]);
  const [disk, setDisk] = useState<DiskText>();
  const [saveAs, setSaveAs] = useState(false);
  const [error, setError] = useState<unknown>();
  const { copied, error: copyError, copy, reset: resetCopy } = useCopyFeedback();
  const tabs = all.filter(
    (item) => item.deviceId === draft.deviceId && item.workspaceId === draft.workspaceId,
  );
  async function save(revision?: string, target = draft.path) {
    if (!target) {
      setSaveAs(true);
      return;
    }
    if (await store.save(draft, target, revision ?? draft.revision, targetOS)) setDisk(undefined);
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
      <DraftTabs store={store} tabs={tabs} draft={draft} hidden={focusMode?.active} />
      <div
        className={`flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-3 max-sm:flex-wrap ${focusMode?.active ? "" : "max-sm:justify-end"}`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-xs ${focusMode?.active ? "max-sm:basis-full max-sm:pt-1" : "max-sm:hidden"}`}
          title={`${draft.deviceName} / ${draft.workspaceName}\n${draft.resolvedPath ?? draftLabel(draft)}`}
        >
          {draftLabel(draft)}
        </span>
        {previewType && (
          <IconButton
            label={
              preview
                ? t(($) => $.files.editSource)
                : previewType === "html"
                  ? t(($) => $.files.previewHtml)
                  : t(($) => $.files.previewMarkdown)
            }
            onClick={togglePreview}
          >
            {preview ? <Code /> : <Eye />}
          </IconButton>
        )}
        <IconButton
          label={t(($) => $.files.downloadFile)}
          disabled={!!unavailable || !draft.path}
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
        {editorVisible && !preview && (
          <IconButton
            label={t(($) => $.files.copyCodeLineReference)}
            disabled={!draft.state}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void copy(codeLineReference(draft), draft.id)}
          >
            <Quote />
          </IconButton>
        )}
        <IconButton
          label={t(($) => $.files.checkDisk)}
          disabled={!!busy || !!unavailable || !canCheckDisk}
          onClick={() => void check()}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label={t(($) => $.files.saveAs)}
          disabled={!draft.state || !!busy || !!unavailable}
          onClick={() => setSaveAs(true)}
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
            <div role="alert" className="flex items-start gap-2 text-destructive">
              <div className="min-w-0 flex-1 break-words">
                <ErrorNotice error={copyError.error} />
              </div>
              <IconButton
                label={t(($) => $.common.dismiss)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={resetCopy}
              >
                <X />
              </IconButton>
            </div>
          )}
          {!!(
            canCheckDisk &&
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
      {draft.state && preview === "html" ? (
        htmlPreviewVisible && (
          <iframe
            title={t(($) => $.files.previewHtml)}
            className="min-h-0 w-full flex-1 border-0 bg-white"
            sandbox="allow-scripts"
            srcDoc={'<!doctype html><base href="about:srcdoc">' + draft.state.doc.toString()}
          />
        )
      ) : draft.state && preview === "markdown" ? (
        <MarkdownPreview
          target={draft}
          text={draft.state.doc.toString()}
          containerRef={previewElement}
          position={previewPosition.current}
        />
      ) : draft.state ? (
        editorVisible && (
          <TextEditor
            key={draft.id}
            {...{ draft, store }}
            onSave={() => {
              if (!unavailable) void save();
            }}
          />
        )
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
                  : draft.state && draft.path
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
      {saveAs && (
        <SaveDraftDialog
          store={store}
          draft={draft}
          targetOS={targetOS}
          onClose={() => setSaveAs(false)}
          onSaved={() => setSaveAs(false)}
        />
      )}
    </>
  );
}
