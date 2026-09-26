import { ErrorNotice } from "../components/error-notice";
import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Circle, Copy, Download, FileOutput, RefreshCw, Save, X } from "lucide-react";
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
import { ApiError } from "../lib/api";
import { copyText } from "../lib/clipboard";
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
import { formatBytes } from "./use-browser";
import { downloadFile, type DiskText } from "./content";

export function DraftView({
  store,
  draft,
  unavailable,
}: {
  store: DraftStore;
  draft: Draft;
  unavailable?: string;
}) {
  const { t } = useTranslation();

  const all = useDrafts(store);
  useDraftVersion(store, draft);
  const [disk, setDisk] = useState<DiskText>();
  const [saveAs, setSaveAs] = useState(false);
  const [path, setPath] = useState(draft.path);
  const [error, setError] = useState<unknown>();
  const [invalid, setInvalid] = useState(false);
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
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <span
          className="min-w-0 flex-1 truncate text-xs"
          title={`${draft.deviceName} / ${draft.workspaceName}\n${draft.resolvedPath ?? draft.path}`}
        >
          {draft.path}
        </span>
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
          onClick={() => {
            void copyText(draft.state!.doc.toString()).catch((reason: unknown) => {
              draft.error = reason;
              store.changed();
            });
          }}
        >
          <Copy />
        </IconButton>
        <IconButton
          label={t(($) => $.files.checkDisk)}
          disabled={!!draft.busy || !!unavailable}
          onClick={() => void check()}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label={t(($) => $.files.saveAs)}
          disabled={!draft.state || !!draft.busy || !!unavailable}
          onClick={() => {
            setPath(draft.path);
            setError(undefined);
            setInvalid(false);
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
      </div>
      {(unavailable ||
        store.overLimit(draft) ||
        draft.notice ||
        draft.diskChanged ||
        draftError(draft) ||
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
          {!!(
            draft.error instanceof ApiError &&
            (draft.error.code === "conflict" || draft.error.outcome === "unknown")
          ) && (
            <Button
              variant="outline"
              disabled={!!draft.busy || !!unavailable}
              onClick={() => void check()}
            >
              {t(($) => $.files.checkDisk)}
            </Button>
          )}
        </div>
      )}
      {draft.state ? (
        <TextEditor
          key={draft.id}
          {...{ draft, store }}
          onSave={() => {
            if (!unavailable) void save();
          }}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
          {draft.busy ? t(($) => $.common.reading) : t(($) => $.files.noText)}
          {!draft.busy && (
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
        <span>
          {draft.busy === "saving"
            ? t(($) => $.files.saving)
            : draft.busy === "checking"
              ? t(($) => $.files.checking)
              : isDirty(draft)
                ? t(($) => $.files.unsaved)
                : draft.state
                  ? t(($) => $.common.saved)
                  : ""}
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
                disabled={!!draft.busy}
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
              if (
                !path ||
                path.startsWith("/") ||
                path.split("/").some((part) => !part || part === "." || part === "..")
              ) {
                setError(undefined);
                setInvalid(true);
                return;
              }
              setInvalid(false);
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
              {invalid && (
                <p role="alert" className="text-sm text-destructive">
                  {t(($) => $.files.savePathRequired)}
                </p>
              )}
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
