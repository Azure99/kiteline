import { useTranslation } from "react-i18next";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Decoration,
  Diff,
  Hunk,
  getChangeKey,
  parseDiff,
  type FileData,
  type ViewType,
} from "react-diff-view";
import type { LanguageSupport } from "@codemirror/language";
import { codeLanguage } from "../lib/code-language";
import { diffTokens } from "./highlight";
import type { InlineHunk } from "./inline-diff";
import { type GitDiff } from "@kiteline/shared/protocol";
import { ApiError, errorMessage, rpc } from "../lib/api";
import { Button } from "../components/ui/button";
import { ErrorNotice, ErrorDetails } from "../components/error-notice";
import { useGitStatusLabel } from "./status-label";

export type DiffTarget = {
  path: string;
} & ({ side: "worktree" | "staged" } | { side: "commit"; commitOid: string; parentOid?: string });

export interface DiffLineSelection {
  patch: string;
  line: number;
}

function comparisonUnavailable(error: unknown) {
  return (
    error instanceof ApiError &&
    error.code === "conflict" &&
    (error.details as { reason?: string } | undefined)?.reason === "change_unavailable"
  );
}
export function DiffView({
  deviceId,
  workspaceId,
  repoId,
  target,
  viewType,
  refreshKey,
  active = true,
  onOtherSide,
  onChanges,
  onOpenLine,
  openLineLabel,
  initialScroll,
  onScrollPosition,
  initialLineSelection,
  onLineSelection,
}: {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  target: DiffTarget;
  viewType: ViewType;
  refreshKey?: unknown;
  active?: boolean;
  onOtherSide?: () => void;
  onChanges?: () => void;
  onOpenLine?: (line: number, focusContent?: boolean) => void;
  openLineLabel?: string;
  initialScroll?: { top: number; left: number };
  onScrollPosition: (position: { top: number; left: number }) => void;
  initialLineSelection?: DiffLineSelection;
  onLineSelection: (selection: DiffLineSelection) => void;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef(initialScroll);
  const pendingFocus = useRef(initialLineSelection);
  const restoreScroll = useCallback((patch: string) => {
    if (!scroll.current) return;
    if (pendingScroll.current) {
      scroll.current.scrollTop = pendingScroll.current.top;
      scroll.current.scrollLeft = pendingScroll.current.left;
    }
    pendingScroll.current = undefined;
    if (pendingFocus.current?.patch === patch) scroll.current.focus({ preventScroll: true });
    pendingFocus.current = undefined;
  }, []);

  const [value, setValue] = useState<GitDiff>();
  const [lineSelection, setLineSelection] = useState(initialLineSelection);
  const selectedLine = lineSelection?.patch === value?.patch ? lineSelection?.line : undefined;
  function chooseLine(line: number, focusContent?: boolean) {
    if (!value) return;
    const selection = { patch: value.patch, line };
    setLineSelection(selection);
    onLineSelection(selection);
    onOpenLine?.(line, focusContent);
  }
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const unavailable = comparisonUnavailable(error);
  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError(undefined);
    void rpc(deviceId, "git.diff", { workspaceId, repoId, ...target }, controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted)
            setValue((old) =>
              old?.patch === result.patch &&
              old.truncated === result.truncated &&
              JSON.stringify(old.summary) === JSON.stringify(result.summary)
                ? old
                : result,
            );
        },
        (error) => {
          if (!controller.signal.aborted) {
            setError(error);
            if (comparisonUnavailable(error)) setValue(undefined);
          }
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [deviceId, workspaceId, repoId, target, refreshKey, active]);
  const historyFeedback = target.side === "commit";
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={t(($) => $.git.diffRegion)}
      aria-busy={busy}
    >
      {historyFeedback && busy && value && (
        <p
          role="status"
          className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          {t(($) => $.git.diffRefreshing)}
        </p>
      )}
      {historyFeedback && !!error && !unavailable && (
        <div
          role="alert"
          className="max-h-24 shrink-0 overflow-auto break-words border-b border-border px-4 py-2 text-xs text-destructive"
        >
          {value ? (
            <>
              {t(($) => $.git.staleDiff, { error: errorMessage(error) })}
              <ErrorDetails error={error} />
            </>
          ) : (
            <ErrorNotice error={error} />
          )}
        </div>
      )}
      <div
        ref={scroll}
        tabIndex={-1}
        className="scroll-area min-h-0 min-w-0 flex-1 overflow-auto"
        onScroll={(event) => {
          if (pendingScroll.current) return;
          onScrollPosition({
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
          });
        }}
      >
        {unavailable && (
          <div className="space-y-3 p-4 text-sm text-muted-foreground">
            <p role="status">{t(($) => $.git.changeUnavailable)}</p>
            {target.side !== "commit" && (onOtherSide || onChanges) && (
              <div className="flex flex-wrap gap-2">
                {onOtherSide && (
                  <Button variant="outline" onClick={onOtherSide}>
                    {t(($) =>
                      target.side === "worktree"
                        ? $.git.openStagedComparison
                        : $.git.openWorktreeComparison,
                    )}
                  </Button>
                )}
                {onChanges && (
                  <Button variant="outline" onClick={onChanges}>
                    {t(($) => $.git.backToChanges)}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {!!error && !unavailable && !historyFeedback && (
          <div role="alert" className="break-words p-4 text-sm text-destructive">
            {value ? (
              <>
                {t(($) => $.git.staleDiff, { error: errorMessage(error) })}
                <ErrorDetails error={error} />
              </>
            ) : (
              <ErrorNotice error={error} />
            )}
          </div>
        )}
        {busy && !value && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t(($) => $.common.reading)}
          </p>
        )}
        {value && (
          <Patch
            value={value}
            viewType={viewType}
            onOpenLine={onOpenLine ? chooseLine : undefined}
            openLineLabel={openLineLabel}
            selectedLine={selectedLine}
            onReady={restoreScroll}
          />
        )}
      </div>
    </section>
  );
}
function Patch({
  value,
  viewType,
  onOpenLine,
  openLineLabel,
  selectedLine,
  onReady,
}: {
  value: GitDiff;
  viewType: ViewType;
  onOpenLine?: (line: number, focusContent?: boolean) => void;
  openLineLabel?: string;
  selectedLine?: number;
  onReady: (patch: string) => void;
}) {
  const { t } = useTranslation();
  const statusLabel = useGitStatusLabel();

  const parsed = useMemo(() => {
    if (value.truncated) return { reason: "diffTruncated" as const };
    if (value.patch.split("\n").length > diffRenderLines)
      return { reason: "diffLineLimit" as const };
    try {
      const files = parseDiff(value.patch);
      if (!files.length && value.patch.trim()) return { reason: "diffUnstructured" as const };
      if (
        !files.some((file) => file.hunks.length) &&
        value.patch
          .split("\n")
          .some(
            (line) =>
              line &&
              !/^(diff --git |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |index |Binary files )/.test(
                line,
              ),
          )
      )
        return { reason: "diffUnparsed" as const };
      return { files };
    } catch {
      return { reason: "diffParseFailed" as const };
    }
  }, [value.patch, value.truncated]);
  const files = parsed.files;
  const [inline, setInline] = useState<
    { files: FileData[] } & (
      | { result: InlineHunk[][]; error?: never }
      | { result?: never; error: unknown }
    )
  >();
  const matching = inline?.files === files ? inline : undefined;
  const needsInline = files?.some((file) => file.hunks.length);
  // Inline alignment changes row heights, so restore saved scroll after that layout settles.
  useLayoutEffect(() => {
    if (!needsInline || matching) onReady(value.patch);
  }, [needsInline, matching, onReady, value.patch]);
  useEffect(() => {
    if (!files?.some((file) => file.hunks.length)) return;
    let worker: Worker | undefined;
    const dispose = () => {
      if (!worker) return;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    try {
      worker = new Worker(new URL("./inline-diff.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<InlineHunk[][]>) => {
        setInline({ files, result: data });
        dispose();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        setInline({ files, error: event.error ?? new Error(event.message) });
        dispose();
      };
      worker.postMessage(files);
    } catch (error) {
      setInline({ files, error });
      dispose();
    }
    return dispose;
  }, [files]);
  const fallback = useMemo(() => {
    if (!parsed.reason) return;
    const bytes = new TextEncoder().encode(value.patch);
    const truncated = bytes.length > diffRawBytes;
    return {
      text: new TextDecoder().decode(bytes.subarray(0, diffRawBytes), { stream: truncated }),
      truncated,
    };
  }, [parsed.reason, value.patch]);
  const summary = value.summary;
  return (
    <>
      {(summary.status ||
        summary.oldPath ||
        summary.binary ||
        summary.oldMode !== summary.newMode) && (
        <div className="space-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {summary.oldPath && (
            <p className="break-all">
              {summary.oldPath} → {summary.path}
            </p>
          )}
          <p>
            {statusLabel(summary.status)}
            {summary.binary ? ` · ${t(($) => $.git.binaryNamed, { path: summary.path })}` : ""}
            {summary.oldMode !== summary.newMode
              ? ` · ${t(($) => $.git.fileMode)}: ${summary.oldMode ?? t(($) => $.git.none)} → ${summary.newMode ?? t(($) => $.git.none)}`
              : ""}
          </p>
        </div>
      )}
      {needsInline && !matching && (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {t(($) => $.git.inlineComputing)}
        </p>
      )}
      {matching && !matching.result && (
        <div role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {t(($) => $.git.inlineUnavailable)}: <ErrorNotice error={matching.error} />
        </div>
      )}
      {parsed.reason ? (
        <>
          <p role="status" className="px-4 py-2 text-xs">
            {t(($) => $.git[parsed.reason!])}
          </p>
          {fallback?.truncated && (
            <p className="px-4 py-2 text-xs">{t(($) => $.git.rawPatchLimited)}</p>
          )}
          <pre className="w-max min-w-full px-4 py-3 font-mono text-xs">{fallback?.text}</pre>
        </>
      ) : (
        parsed.files?.map((file, index) => (
          <DiffBlock
            key={index}
            file={file}
            viewType={viewType}
            patch={value.patch}
            inline={matching?.result?.[index]}
            onOpenLine={
              summary.newMode === "100644" || summary.newMode === "100755" ? onOpenLine : undefined
            }
            openLineLabel={openLineLabel}
            selectedLine={selectedLine}
          />
        ))
      )}
    </>
  );
}
function DiffBlock({
  file,
  viewType,
  patch,
  inline,
  onOpenLine,
  openLineLabel,
  selectedLine,
}: {
  file: FileData;
  viewType: ViewType;
  patch: string;
  inline?: InlineHunk[];
  onOpenLine?: (line: number, focusContent?: boolean) => void;
  openLineLabel?: string;
  selectedLine?: number;
}) {
  const { t } = useTranslation();
  const [support, setSupport] = useState<{
    oldPath: string;
    newPath: string;
    old?: LanguageSupport;
    new?: LanguageSupport;
    error?: unknown;
  }>();
  const { oldPath, newPath } = file;
  useEffect(() => {
    let active = true;
    void Promise.all([codeLanguage(oldPath)?.load(), codeLanguage(newPath)?.load()]).then(
      ([old, next]) => {
        if (active) setSupport({ oldPath, newPath, old, new: next });
      },
      (error) => {
        if (active) setSupport({ oldPath, newPath, error });
      },
    );
    return () => {
      active = false;
    };
  }, [oldPath, newPath]);
  const matching =
    support?.oldPath === file.oldPath && support?.newPath === file.newPath ? support : undefined;
  const tokens = useMemo(
    () => diffTokens(file, matching?.old, matching?.new, inline),
    [file, matching, inline],
  );
  const largestLineNumber = file.hunks.reduce(
    (largest, hunk) =>
      Math.max(largest, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1),
    1,
  );
  const gutterWidth = `${String(largestLineNumber).length + 4}ch`;
  const selectedChange =
    selectedLine === undefined
      ? undefined
      : file.hunks
          .flatMap((hunk) => hunk.changes)
          .find(
            (change) =>
              change.type !== "delete" &&
              (change.type === "normal" ? change.newLineNumber : change.lineNumber) ===
                selectedLine,
          );
  return (
    <div
      style={{ "--kiteline-diff-gutter-width": gutterWidth } as CSSProperties}
      className="max-desk:[&_.diff-gutter]:relative"
    >
      {!!matching?.error && (
        <div role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {t(($) => $.common.syntaxUnavailable)}: <ErrorNotice error={matching.error} />
        </div>
      )}
      <Diff
        // Replacing the token subtree avoids React's quadratic sibling insertion on long lines.
        key={`${matching?.old || matching?.new ? patch : "plain"}:${!!inline}`}
        viewType={viewType}
        optimizeSelection
        diffType={file.type}
        hunks={file.hunks}
        tokens={tokens}
        className="kiteline-diff"
        selectedChanges={selectedChange ? [getChangeKey(selectedChange)] : []}
        renderGutter={({ change, side, renderDefault }) => {
          const content = (
            <span aria-hidden="true" className="select-none">
              {renderDefault()}
              <span className="diff-gutter-marker">
                {side === "new" || (viewType === "split" && side === "old")
                  ? change.type === "insert"
                    ? "+"
                    : change.type === "delete"
                      ? "−"
                      : ""
                  : ""}
              </span>
            </span>
          );
          if (side !== "new" || change.type === "delete" || !onOpenLine) return content;
          const line = change.type === "normal" ? change.newLineNumber : change.lineNumber;
          const label = openLineLabel
            ? `${t(($) => $.git.worktreeLine, { line })}: ${openLineLabel}`
            : t(($) => $.git.openWorktreeLine, { line });
          return (
            <button
              type="button"
              aria-label={label}
              title={label}
              className="w-full cursor-pointer text-primary underline decoration-dotted underline-offset-2 hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary max-desk:absolute max-desk:inset-0 max-desk:flex max-desk:h-full max-desk:items-start max-desk:justify-end max-desk:pr-[1ch]"
              onClick={() => onOpenLine(line)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.ctrlKey ||
                  event.altKey ||
                  event.metaKey ||
                  event.shiftKey
                )
                  return;
                event.preventDefault();
                onOpenLine(line, true);
              }}
            >
              {content}
            </button>
          );
        }}
        renderToken={(token, renderDefault, index) =>
          token.type === "empty" ? <br key={index} /> : renderDefault(token, index)
        }
      >
        {(hunks) =>
          hunks.map((hunk, index) => (
            <Fragment key={hunk.content}>
              <Decoration className="bg-primary-soft text-muted-foreground">
                <span className="block px-2 py-1">{hunk.content}</span>
              </Decoration>
              {viewType === "split" && inline ? (
                inline[index]!.rows.map(([old, next], row) => (
                  <Hunk
                    key={row}
                    hunk={{
                      ...hunk,
                      changes: (old === next ? [old] : [old, next])
                        .filter((change) => change !== null)
                        .map((change) => hunk.changes[change]!),
                    }}
                  />
                ))
              ) : (
                <Hunk hunk={hunk} />
              )}
            </Fragment>
          ))
        }
      </Diff>
      {(file.oldEndingNewLine === false || file.newEndingNewLine === false) && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {t(($) =>
            file.oldEndingNewLine === false && file.newEndingNewLine === false
              ? $.git.noNewlineBoth
              : file.oldEndingNewLine === false
                ? $.git.noNewlineOld
                : $.git.noNewlineNew,
          )}
        </p>
      )}
    </div>
  );
}

const diffRenderLines = 2000;
const diffRawBytes = 32 * 1024;
