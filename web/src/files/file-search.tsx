import { useTranslation } from "react-i18next";
import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, File, Search, X } from "lucide-react";
import type { SearchMatch, SearchResult } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { rpc } from "../lib/api";
import { ErrorNotice } from "../components/error-notice";

export function FileSearch({
  deviceId,
  workspaceId,
  workspaceName,
  visible,
  disabled,
  onBack,
  onOpen,
}: {
  deviceId: string;
  workspaceId: string;
  workspaceName: string;
  visible: boolean;
  disabled: boolean;
  onBack: () => void;
  onOpen: (match: SearchMatch) => void;
}) {
  const { t } = useTranslation();

  const [mode, setMode] = useState<"name" | "content">("content");
  const [query, setQuery] = useState("");
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [result, setResult] = useState<SearchResult>();
  const [status, setStatus] = useState<{ kind: "cancelled" } | { kind: "error"; error: unknown }>();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  function cancel() {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
    setStatus({ kind: "cancelled" });
  }
  async function search() {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setBusy(true);
    setResult(undefined);
    setStatus(undefined);
    try {
      const next = await rpc(
        deviceId,
        "files.search",
        { workspaceId, mode, query, includeIgnored },
        current.signal,
      );
      if (request.current === current) setResult(next);
    } catch (error) {
      if (request.current === current) setStatus({ kind: "error", error });
    } finally {
      if (request.current === current) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      aria-label={t(($) => $.files.searchTitle)}
    >
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <IconButton label={t(($) => $.files.backFiles)} onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <span className="min-w-0 truncate text-xs">
          {t(($) => $.files.searchWorkspace, { name: workspaceName })}
        </span>
      </div>
      <form
        className="shrink-0 space-y-3 border-b border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label={t(($) => $.files.searchType)}
            className="inline-flex rounded-md bg-muted p-0.5"
          >
            {(
              [
                ["content", t(($) => $.files.content)],
                ["name", t(($) => $.common.fileName)],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                className={`min-h-8 px-3 text-xs max-desk:min-h-11 ${mode === value ? "rounded bg-background shadow-xs" : "text-muted-foreground"}`}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground max-desk:min-h-11">
            <input
              type="checkbox"
              checked={includeIgnored}
              onChange={(event) => setIncludeIgnored(event.target.checked)}
            />
            {t(($) => $.files.includeIgnored)}
          </label>
        </div>
        <div className="flex gap-2">
          <Input
            aria-label={t(($) => $.files.searchQuery)}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={disabled || !query}>
            <Search />
            {t(($) => $.common.search)}
          </Button>
          {busy && (
            <IconButton label={t(($) => $.files.cancelSearch)} onClick={cancel}>
              <X />
            </IconButton>
          )}
        </div>
      </form>
      <div className="scroll-area min-h-0 flex-1 overflow-auto">
        {(busy || status || result) && (
          <div
            role="status"
            className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
          >
            {busy ? (
              t(($) => $.files.searching)
            ) : status?.kind === "error" ? (
              <ErrorNotice error={status.error} />
            ) : status?.kind === "cancelled" ? (
              t(($) => $.common.cancelled)
            ) : result?.truncated ? (
              t(($) => $.files.partialMatches, { count: result.matches.length })
            ) : result?.matches.length ? (
              t(($) => $.files.matches, { count: result.matches.length })
            ) : (
              t(($) => $.files.noMatches)
            )}
          </div>
        )}
        {result?.matches.map((match, index) => (
          <button
            key={index}
            onClick={() => onOpen(match)}
            className="block w-full border-b border-border px-4 py-3 text-left hover:bg-muted"
          >
            <span className="flex items-start gap-2 text-xs">
              <File className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-all">
                {match.path}
                {match.line ? `:${match.line}` : ""}
              </span>
            </span>
            {match.text !== undefined && (
              <span className="mt-2 block overflow-x-auto whitespace-pre font-mono text-xs text-muted-foreground">
                <MatchText match={match} />
                {match.truncated && (
                  <span className="ml-2 font-sans">{t(($) => $.files.snippetTruncated)}</span>
                )}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

function MatchText({ match }: { match: SearchMatch }) {
  const text = match.text ?? "";
  let from = 0;
  return (
    <>
      {match.ranges?.map(([start, end], index) => {
        const plain = text.slice(from, start);
        from = end;
        return (
          <Fragment key={index}>
            {plain}
            <mark className="bg-amber-200/70 text-foreground">{text.slice(start, end)}</mark>
          </Fragment>
        );
      })}
      {text.slice(from)}
    </>
  );
}
