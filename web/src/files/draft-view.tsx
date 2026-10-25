import { flushSync } from "react-dom";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
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
  FolderOpen,
  Fullscreen,
  Minimize,
  Minimize2,
  MoreHorizontal,
  Quote,
  RefreshCw,
  Save,
  Scan,
  Search,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
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
import { navigateWorkspace } from "../lib/navigation";
import { parentPath } from "./paths";
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
import { TextEditor, type TextEditorHandle } from "./text-editor";
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
  showTabs = true,
}: {
  focusMode?: ReturnType<typeof useTerminalFocus>;
  editorVisible?: boolean;
  htmlPreviewVisible?: boolean;
  showTabs?: boolean;
  store: DraftStore;
  draft: Draft;
  targetOS?: AgentEnvironment["os"];
  unavailable?: string;
}) {
  const { t } = useTranslation();

  const editor = useRef<TextEditorHandle>(null);
  const [searchFromMenu, setSearchFromMenu] = useState(false);
  const menuActions = useRef<MenuPrimitive.Root.Actions>(null);
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
  const [htmlPreview, setHtmlPreview] = useState(false);
  if (htmlPreview && previewType !== "html") setHtmlPreview(false);
  const preview =
    previewType === "markdown" && draft.markdownPreview
      ? "markdown"
      : previewType === "html" && htmlPreview
        ? "html"
        : undefined;
  const setPreview = useCallback(
    (value?: "markdown" | "html") => {
      if (previewType === "markdown") {
        draft.markdownPreview = value === "markdown";
        store.changed(draft, false);
      } else setHtmlPreview(value === "html");
    },
    [draft, previewType, store],
  );
  const previewElement = useRef<HTMLElement>(null);
  const rememberPreviewPosition = useCallback(() => {
    const article = previewElement.current;
    if (preview === "markdown" && article) {
      const viewport = article.getBoundingClientRect();
      if (!viewport.width || !viewport.height) return;
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
        draft.markdownPosition = {
          line,
          offset: nearest.getBoundingClientRect().top - viewport.top,
        };
        return line;
      }
    }
  }, [draft, preview]);
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
  }, [preview, draft.location, rememberPreviewPosition, setPreview]);
  useLayoutEffect(() => () => void rememberPreviewPosition(), [rememberPreviewPosition]);
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
  const downloadDisabled = !!unavailable || !draft.path;
  const checkDisabled = !!busy || !!unavailable || !canCheckDisk;
  const saveAsDisabled = !draft.state || !!busy || !!unavailable;
  const download = () => downloadFile(draft);
  const openSaveAs = () => setSaveAs(true);
  if (!store.has(draft))
    return <div className="p-4 text-sm text-muted-foreground">{t(($) => $.files.closed)}</div>;
  return (
    <>
      {showTabs && <DraftTabs store={store} tabs={tabs} draft={draft} hidden={focusMode?.active} />}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-end border-b border-border px-1">
        <span
          className="min-w-0 flex-1 basis-32 truncate px-2 text-xs max-sm:basis-full max-sm:whitespace-pre-wrap max-sm:break-all max-sm:pt-1"
          title={`${draft.deviceName} / ${draft.workspaceName}\n${draft.resolvedPath ?? draftLabel(draft)}`}
        >
          {draftLabel(draft)}
        </span>
        <div className="ml-auto flex max-w-full flex-wrap justify-end">
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
          <IconButton
            label={t(($) => $.files.saveFile)}
            disabled={!store.canSave(draft) || !!unavailable}
            onClick={() => void save()}
          >
            <Save />
          </IconButton>
          <Menu
            actionsRef={menuActions}
            onOpenChange={(open) => {
              if (open) setSearchFromMenu(false);
            }}
          >
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label={t(($) => $.files.moreActions)} />
              }
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent finalFocus={searchFromMenu ? false : undefined}>
              {editorVisible && draft.state && !preview && (
                <MenuItem
                  closeOnClick={false}
                  onClick={() => {
                    // Release the menu focus lock within the touch gesture so Android opens the IME.
                    flushSync(() => setSearchFromMenu(true));
                    flushSync(() => {
                      menuActions.current?.close();
                      menuActions.current?.unmount();
                    });
                    editor.current?.openSearch();
                  }}
                >
                  <Search />
                  {t(($) => $.files.findReplace)}
                </MenuItem>
              )}
              <MenuItem
                disabled={!draft.state}
                onClick={() => void copy(draft.state!.doc.toString(), draft.id)}
              >
                <Copy />
                {t(($) => $.files.copyText)}
              </MenuItem>
              <MenuItem
                disabled={!draft.path}
                onClick={() =>
                  navigateWorkspace(draft, "files", {
                    folder: parentPath(draft.path),
                    reveal: draft.path,
                    search: undefined,
                    line: undefined,
                  })
                }
              >
                <FolderOpen />
                {t(($) => $.files.openContainingDirectory)}
              </MenuItem>
              <MenuItem disabled={downloadDisabled} onClick={download}>
                <Download />
                {t(($) => $.files.downloadFile)}
              </MenuItem>
              <div className="my-1 border-t border-border" />
              <MenuItem disabled={checkDisabled} onClick={() => void check()}>
                <RefreshCw />
                {t(($) => $.files.checkDisk)}
              </MenuItem>
              <MenuItem disabled={saveAsDisabled} onClick={openSaveAs}>
                <FileOutput />
                {t(($) => $.files.saveAs)}
              </MenuItem>
              {focusMode && (
                <>
                  <div className="my-1 border-t border-border" />
                  <MenuItem onClick={() => void focusMode.toggleFullscreen()}>
                    {focusMode.fullscreen ? <Minimize2 /> : <Fullscreen />}
                    {t(($) =>
                      focusMode.fullscreen ? $.terminal.exitFullscreen : $.terminal.enterFullscreen,
                    )}
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>
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
          position={draft.markdownPosition}
          visible={editorVisible && !draft.location}
          onScroll={rememberPreviewPosition}
        />
      ) : draft.state ? (
        editorVisible && (
          <TextEditor
            ref={editor}
            key={draft.id}
            {...{ draft, store }}
            wrap={previewType === "markdown"}
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
