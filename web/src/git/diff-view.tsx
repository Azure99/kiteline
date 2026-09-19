import { useTranslation } from "react-i18next";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Decoration, Diff, Hunk, parseDiff, type FileData, type HunkTokens } from "react-diff-view";
import "react-diff-view/style/index.css";
import { ArrowLeft, FilePenLine, RefreshCw } from "lucide-react";
import { limits, type GitDiff } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { errorMessage, rpc } from "../lib/api";
import { ErrorNotice, ErrorDetails } from "../components/error-notice";

export type DiffTarget = {
  path: string;
} & ({ side: "worktree" | "staged" } | { side: "commit"; commitOid: string; parentOid?: string });
export function DiffView({
  deviceId,
  workspaceId,
  repoId,
  target,
  refreshKey,
  onBack,
  onFile,
}: {
  deviceId: string;
  workspaceId: string;
  repoId: string;
  target: DiffTarget;
  refreshKey?: unknown;
  onBack: () => void;
  onFile: () => void;
}) {
  const { t } = useTranslation();

  const [value, setValue] = useState<GitDiff>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
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
          if (!controller.signal.aborted) setError(error);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [deviceId, workspaceId, repoId, target, refreshKey, retry]);
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Git diff"
      aria-busy={busy}
    >
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton label={t(($) => $.git.backChanges)} onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-xs" title={target.path}>
          {target.path}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {target.side === "staged"
            ? t(($) => $.git.index)
            : target.side === "commit"
              ? t(($) => $.git.commit)
              : t(($) => $.git.worktree)}
        </span>
        <IconButton label={t(($) => $.git.openFiles)} onClick={onFile}>
          <FilePenLine />
        </IconButton>
        <IconButton
          label={t(($) => $.git.refreshDiff)}
          disabled={busy}
          onClick={() => setRetry((n) => n + 1)}
        >
          <RefreshCw />
        </IconButton>
      </div>
      <div className="scroll-area min-h-0 min-w-0 flex-1 overflow-auto">
        {!!error && (
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
        {value && <Patch value={value} />}
      </div>
    </section>
  );
}
export function Patch({ value }: { value: GitDiff }) {
  const { t } = useTranslation();

  const parsed = useMemo(() => {
    if (value.truncated) return { reason: "diffTruncated" as const };
    if (value.patch.split("\n").length > limits.diffRenderLines)
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
  }, [value]);
  const bytes = new TextEncoder().encode(value.patch);
  const raw = new TextDecoder().decode(bytes.subarray(0, limits.diffRawBytes), {
    stream: bytes.length > limits.diffRawBytes,
  });
  const summary = value.summary;
  return (
    <>
      {(summary.oldPath || summary.binary || summary.oldMode !== summary.newMode) && (
        <div className="space-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {summary.oldPath && (
            <p className="break-all">
              {summary.oldPath} → {summary.path}
            </p>
          )}
          <p>
            {summary.binary
              ? t(($) => $.git.binaryNamed, { path: summary.status })
              : summary.status}
            {summary.oldMode !== summary.newMode
              ? ` · ${summary.oldMode ?? t(($) => $.git.none)} → ${summary.newMode ?? t(($) => $.git.none)}`
              : ""}
          </p>
        </div>
      )}
      {parsed.reason ? (
        <>
          <p role="status" className="px-4 py-2 text-xs">
            {t(($) => $.git[parsed.reason!])}
          </p>
          {bytes.length > limits.diffRawBytes && (
            <p className="px-4 py-2 text-xs">{t(($) => $.git.rawPatchLimited)}</p>
          )}
          <pre className="w-max min-w-full px-4 py-3 font-mono text-xs">{raw}</pre>
        </>
      ) : (
        parsed.files?.map((file, index) => <DiffBlock key={index} file={file} />)
      )}
    </>
  );
}
function DiffBlock({ file }: { file: FileData }) {
  const { t } = useTranslation();

  const tokens: HunkTokens = { old: [], new: [] };
  for (const hunk of file.hunks)
    for (const change of hunk.changes)
      if (change.content === "") {
        if (change.type === "delete") tokens.old[change.lineNumber - 1] = [{ type: "empty" }];
        else
          tokens.new[(change.type === "insert" ? change.lineNumber : change.newLineNumber) - 1] = [
            { type: "empty" },
          ];
      }
  return (
    <>
      <Diff
        viewType="unified"
        diffType={file.type}
        hunks={file.hunks}
        tokens={tokens}
        className="kiteline-diff"
        renderGutter={({ change, side, renderDefault }) => (
          <span aria-hidden="true" className="select-none">
            {renderDefault()}
            {side === "new"
              ? change.type === "insert"
                ? " +"
                : change.type === "delete"
                  ? " −"
                  : ""
              : ""}
          </span>
        )}
        renderToken={(token, renderDefault, index) =>
          token.type === "empty" ? <br key={index} /> : renderDefault(token, index)
        }
      >
        {(hunks) =>
          hunks.map((hunk) => (
            <Fragment key={hunk.content}>
              <Decoration className="bg-primary-soft text-muted-foreground">
                <span className="block px-2 py-1">{hunk.content}</span>
              </Decoration>
              <Hunk hunk={hunk} />
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
    </>
  );
}
