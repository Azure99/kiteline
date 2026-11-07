import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, List, X } from "lucide-react";
import type { Text } from "@codemirror/state";
import type { TextLocation } from "./text-editor";
import { searchPosition } from "./search-position";
import type { SearchMatch } from "@kiteline/shared/protocol";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { IconButton } from "../components/icon-button";
import { ErrorNotice } from "../components/error-notice";
import { useMobile } from "../lib/use-mobile";
import { readText, type DiskText } from "./content";
import { isDirty, useDraftVersion, type Draft, type DraftStore } from "./drafts";
import { ReadOnlyReader, type ReadOnlyReaderHandle } from "./read-only-reader";

export interface NavigationPeekProps {
  deviceId: string;
  workspaceId: string;
  store: DraftStore;
  query: string;
  origin: { path: string; line?: number };
  selected: SearchMatch;
  requestId: string;
  missing: boolean;
  draftId?: string;
  location: TextLocation;
  index: number;
  count: number;
  group: "definitions" | "occurrences";
  hasNext: boolean;
  truncated?: boolean;
  onPrevious(): void;
  onNext(): void;
  onShowCandidates(): void;
  onOpen(): void;
  onClose(): void;
}

export function NavigationPeek(props: NavigationPeekProps) {
  const { t } = useTranslation();
  const mobile = useMobile();
  const reader = useRef<ReadOnlyReaderHandle>(null);
  const { selected, deviceId, workspaceId, store } = props;
  const draft = store.find({ deviceId, workspaceId, path: selected.path }, props.draftId);
  const body = (
    <>
      <div
        className={`flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 ${mobile ? "pr-12" : ""}`}
      >
        <Button variant="ghost" className="min-w-0 flex-1 justify-start" onClick={props.onClose}>
          <ArrowLeft />
          <span className="truncate">
            {props.origin.line === undefined
              ? props.origin.path.slice(props.origin.path.lastIndexOf("/") + 1)
              : t(($) => $.files.peekReturn, {
                  path: props.origin.path.slice(props.origin.path.lastIndexOf("/") + 1),
                  line: props.origin.line,
                })}
          </span>
        </Button>
        {!mobile && (
          <IconButton label={t(($) => $.common.close)} onClick={props.onClose}>
            <X />
          </IconButton>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <IconButton label={t(($) => $.files.peekCandidates)} onClick={props.onShowCandidates}>
          <List />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-xs" title={selected.path}>
          {selected.path}:{selected.line ?? 1}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {props.index >= 0 ? props.index + 1 : "–"}/{props.count}
        </span>
        <IconButton
          label={t(($) => $.files.peekPrevious)}
          disabled={props.index <= 0}
          focusableWhenDisabled
          onClick={props.onPrevious}
        >
          <ChevronLeft />
        </IconButton>
        <IconButton
          label={t(($) => $.files.peekNext)}
          disabled={!props.hasNext}
          focusableWhenDisabled
          onClick={props.onNext}
        >
          <ChevronRight />
        </IconButton>
      </div>
      {props.truncated && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {t(($) => $.files.navigationPartialMatches, { count: props.count })}
        </div>
      )}
      {draft?.state ? (
        <DraftPreview {...props} draft={draft} reader={reader} />
      ) : (
        <DiskPreview
          key={`${deviceId}:${workspaceId}:${selected.path}`}
          {...props}
          reader={reader}
        />
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-2">
        <Button variant="outline" onClick={() => reader.current?.openSearch()}>
          {t(($) => $.files.findInReading)}
        </Button>
        <Button
          variant="outline"
          className="ml-auto"
          disabled={props.missing}
          onClick={props.onOpen}
        >
          {t(($) => $.files.peekOpen)}
        </Button>
      </div>
    </>
  );
  const title = t(($) => $.files.peekTitle, { query: props.query });
  if (mobile)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogContent
          style={{
            height: "var(--app-height, var(--viewport-height))",
            maxHeight: "var(--app-height, var(--viewport-height))",
            borderRadius: 0,
          }}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        </DialogContent>
      </Dialog>
    );
  return (
    <section
      aria-label={title}
      className="flex h-[55%] min-h-[260px] shrink-0 flex-col border-t-2 border-primary bg-background"
    >
      {body}
    </section>
  );
}

function DraftPreview({
  draft,
  reader,
  ...props
}: NavigationPeekProps & {
  draft: Draft;
  reader: React.RefObject<ReadOnlyReaderHandle | null>;
}) {
  const { t } = useTranslation();
  useDraftVersion(props.store, draft);
  const text = draft.state!.doc;
  useLayoutEffect(
    () =>
      props.store.subscribeTransactions((changed, transactions) => {
        if (changed === draft && transactions) reader.current?.applyTransactions(transactions);
      }),
    [props.store, draft, reader],
  );
  return (
    <>
      {isDirty(draft) && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {t(($) => $.files.unsaved)}
        </div>
      )}
      <PreviewText {...props} text={text} reader={reader} />
    </>
  );
}

function DiskPreview(
  props: NavigationPeekProps & {
    reader: React.RefObject<ReadOnlyReaderHandle | null>;
  },
) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, selected } = props;
  const [loaded, setLoaded] = useState<DiskText>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const request = new AbortController();
    setLoaded(undefined);
    setError(undefined);
    void readText({ deviceId, workspaceId, path: selected.path }, request.signal).then(
      (disk) => {
        if (!request.signal.aborted) setLoaded(disk);
      },
      (failure) => {
        if (!request.signal.aborted) setError(failure);
      },
    );
    return () => request.abort();
  }, [deviceId, workspaceId, selected.path]);
  if (error)
    return (
      <div role="alert" className="min-h-0 flex-1 overflow-auto p-3 text-sm">
        <ErrorNotice error={error} />
      </div>
    );
  if (!loaded)
    return (
      <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm">
        {t(($) => $.common.loading)}
      </div>
    );
  return <PreviewText {...props} text={loaded.text} raw={loaded.raw} />;
}

function PreviewText({
  selected,
  requestId,
  missing,
  query,
  group,
  text,
  raw,
  location: target,
  reader,
}: NavigationPeekProps & {
  text: string | Text;
  raw?: string;
  reader: React.RefObject<ReadOnlyReaderHandle | null>;
}) {
  const { t } = useTranslation();
  const location = useMemo(() => {
    const found =
      target.source === "draft"
        ? { line: target.line, column: target.column }
        : raw === undefined
          ? undefined
          : searchPosition(raw, target.line, query, target.range?.[0], {
              byteColumn: target.byteColumn,
              wholeWord: true,
            });
    return {
      line: found?.line ?? 1,
      column: found?.column,
      unmapped: missing || target.unmapped || !found,
      query,
      align: group === "definitions" ? ("start" as const) : ("center" as const),
    };
  }, [target, missing, query, raw, group]);
  return (
    <ReadOnlyReader
      ref={reader}
      text={text}
      path={selected.path}
      location={location}
      locationRequestId={requestId}
      label={t(($) => $.files.peekTitle, { query })}
    />
  );
}
