import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, File, Search, X } from "lucide-react";
import type { SearchMatch, SearchResult } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { errorMessage, rpc } from "../lib/api";

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
  const [mode, setMode] = useState<"name" | "content">("content");
  const [query, setQuery] = useState("");
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [result, setResult] = useState<SearchResult>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  function cancel() {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
    setStatus("已取消");
  }
  async function search() {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setBusy(true);
    setResult(undefined);
    setStatus("");
    try {
      const next = await rpc<SearchResult>(
        deviceId,
        "files.search",
        { workspaceId, mode, query, includeIgnored },
        current.signal,
      );
      if (request.current === current) setResult(next);
    } catch (error) {
      if (request.current === current) setStatus(errorMessage(error));
    } finally {
      if (request.current === current) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }
  return (
    <section className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-label="文件搜索">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <IconButton label="返回文件" onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <span className="min-w-0 truncate text-xs">搜索 · {workspaceName}</span>
      </div>
      <form
        className="shrink-0 space-y-3 border-b border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="搜索类型" className="inline-flex rounded-md bg-muted p-0.5">
            {(
              [
                ["content", "正文"],
                ["name", "文件名"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                className={`min-h-8 px-3 text-xs max-[959px]:min-h-11 ${mode === value ? "rounded bg-background shadow-xs" : "text-muted-foreground"}`}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground max-[959px]:min-h-11">
            <input
              type="checkbox"
              checked={includeIgnored}
              onChange={(event) => setIncludeIgnored(event.target.checked)}
            />
            包含已忽略项
          </label>
        </div>
        <div className="flex gap-2">
          <Input
            aria-label="搜索内容"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={disabled || !query}>
            <Search />
            搜索
          </Button>
          {busy && (
            <IconButton label="取消搜索" onClick={cancel}>
              <X />
            </IconButton>
          )}
        </div>
      </form>
      <div className="scroll-area min-h-0 flex-1 overflow-auto">
        {(busy || status || result) && (
          <p
            role="status"
            className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
          >
            {busy
              ? "正在搜索"
              : status ||
                (result?.truncated
                  ? `${result.matches.length} 项 · 结果不完整`
                  : result?.matches.length
                    ? `${result.matches.length} 项`
                    : "没有匹配")}
          </p>
        )}
        {result?.matches.map((match, index) => (
          <button
            key={index}
            onClick={() => onOpen(match)}
            className="block w-full border-b border-border px-4 py-3 text-left hover:bg-accent"
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
                {match.truncated && <span className="ml-2 font-sans">片段已截断</span>}
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
