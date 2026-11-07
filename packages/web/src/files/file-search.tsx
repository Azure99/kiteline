import { useTranslation } from "react-i18next";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Search, X } from "lucide-react";
import { FileIcon } from "../components/file-icon";
import type { SearchMatch } from "@kiteline/shared/protocol";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { isMobile } from "../lib/use-mobile";
import { ErrorNotice } from "../components/error-notice";
import {
  navigationSearchEntries,
  type CodeNavigationRequest,
  type NavigationSearchEntry,
} from "./code-navigation";
import type { DraftStore } from "./drafts";
import type { FileSearchMemory, OpenSearchEntry } from "./file-search-state";
import { useFileSearch } from "./use-file-search";
import { useHistoricalFileLocation } from "./navigation";
import { NavigationPeek } from "./navigation-peek";

type NavigationGroup = CodeNavigationRequest["initialGroup"];
export interface FileSearchHandle {
  navigateName(request: CodeNavigationRequest): void;
  showSearch(): void;
}

export function FileSearch({
  memory,
  ref,
  actionRef,
  deviceId,
  workspaceId,
  workspaceName,
  active,
  disabled,
  onBack,
  onOpen,
  navigationHost,
  store,
  onShowCandidates,
  onShowContent,
  onCloseNavigation,
}: {
  memory: FileSearchMemory;
  ref?: Ref<HTMLElement>;
  actionRef?: Ref<FileSearchHandle>;
  deviceId: string;
  workspaceId: string;
  workspaceName: string;
  active: boolean;
  disabled: boolean;
  onBack(): void;
  onOpen: OpenSearchEntry;
  navigationHost: HTMLElement | null;
  store: DraftStore;
  onShowCandidates(): void;
  onShowContent(): void;
  onCloseNavigation(): void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const groupHeadings = useRef<Partial<Record<NavigationGroup, HTMLHeadingElement | null>>>({});
  const historical = useHistoricalFileLocation();
  const search = useFileSearch({ memory, deviceId, workspaceId, store, onOpen, onShowContent });
  const {
    manual,
    nameSearch,
    session,
    view,
    peekVisible,
    entries: navigationEntries,
    activity: { busy, status },
    changeSearch,
    cancel,
    previewAt,
    openDocumentAt,
  } = search;
  const pendingGroup = useRef<NavigationGroup | undefined>(undefined);
  const navigation = view === "navigation" ? session : undefined;
  const originLocation = session?.tracker.originLocation();
  const result = navigation ? nameSearch?.result : manual.result;
  const entries = useMemo(
    () => (navigation ? navigationEntries : navigationSearchEntries(manual.result)),
    [navigation, navigationEntries, manual.result],
  );
  const { mode, query, includeIgnored, wholeWord } = manual;
  const selection = nameSearch?.selection;
  const selectedIndex = selection
    ? navigationEntries.findIndex((entry) => entry.key === selection.entry.key)
    : -1;
  const selected = navigationEntries[selectedIndex] ?? selection?.entry;
  const selectionMissing = !!selection && selectedIndex < 0;
  const documentIndex =
    historical?.kind === "document" && historical.sessionId === session?.id ? selectedIndex : -1;
  const activeIndex = peekVisible ? selectedIndex : documentIndex;
  const nextIndex = selectionMissing
    ? -1
    : navigationEntries.findIndex((entry, index) => index > activeIndex && !entry.isOrigin);
  const definitionCount = navigationEntries.filter((entry) => entry.group === "definitions").length;
  const groups = [
    {
      key: "definitions" as const,
      label: t(($) => $.files.possibleDefinitions),
      count: definitionCount,
      start: 0,
    },
    {
      key: "occurrences" as const,
      label: t(($) => $.files.otherOccurrences),
      count: navigationEntries.length - definitionCount,
      start: definitionCount,
    },
  ];
  const focusEmpty = useEffectEvent(() => {
    if (view === "manual" && !isMobile() && !query && !busy && !status && !result)
      input.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (active) focusEmpty();
  }, [active, view]);
  function openAt(index: number, focusContent = false) {
    if (navigation) previewAt(index);
    else {
      const entry = entries[index];
      if (entry)
        onOpen({
          kind: "search",
          entry,
          query: manual.result?.query,
          wholeWord: manual.result?.wholeWord ?? false,
          focusContent,
        });
    }
  }
  function returnToOrigin() {
    if (!search.returnToOrigin()) {
      onShowContent();
      onCloseNavigation();
    }
  }
  function locateGroup(group: NavigationGroup) {
    const heading = groupHeadings.current[group];
    heading?.scrollIntoView({ block: "start", inline: "nearest" });
    if (!isMobile()) heading?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    const group = pendingGroup.current;
    pendingGroup.current = undefined;
    if (active && navigation && group) locateGroup(group);
  }, [active, navigation]);
  useEffect(() => {
    if (!active || !navigation || busy) return;
    const heading = Object.values(groupHeadings.current).find(
      (heading) => heading && heading.ownerDocument.activeElement === heading,
    );
    heading?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [active, navigation, nameSearch, busy]);
  useImperativeHandle(actionRef, () => ({
    showSearch: search.showSearch,
    navigateName(next) {
      if (disabled) return;
      search.navigateName(next);
      pendingGroup.current = next.initialGroup;
    },
  }));
  function showCandidates() {
    search.showCandidates(isMobile());
    onShowCandidates();
    locateGroup(navigationEntries[activeIndex]?.group ?? "definitions");
  }
  function renderEntry(entry: NavigationSearchEntry, index: number) {
    return (
      <button
        key={entry.key}
        aria-current={navigation && activeIndex === index ? "location" : undefined}
        onClick={() => openAt(index)}
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
          openAt(index, true);
        }}
        className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-muted ${navigation && activeIndex === index ? "bg-primary-soft" : ""}`}
      >
        <span className="flex items-start gap-2 text-xs">
          <FileIcon path={entry.match.path} size={14} className="mt-0.5" />
          <span className="min-w-0 break-all">
            {entry.match.path}
            {entry.match.line ? `:${entry.match.line}` : ""}
          </span>
          {entry.isOrigin && (
            <span className="ml-auto shrink-0 text-primary">
              {t(($) => $.files.navigationStart)}
            </span>
          )}
        </span>
        {entry.match.text !== undefined && <MatchText match={entry.match} />}
      </button>
    );
  }
  const navigationBody = navigation && peekVisible && selected && (
    <NavigationPeek
      deviceId={deviceId}
      workspaceId={workspaceId}
      store={store}
      query={navigation.context.query}
      origin={{
        path: navigation.origin.path,
        line: originLocation?.unmapped ? undefined : originLocation?.line,
      }}
      selected={selected.match}
      requestId={selection!.requestId}
      missing={selectionMissing}
      location={navigation.tracker.entryLocation(selection!.entry.key)}
      draftId={selected.draftId}
      truncated={nameSearch?.result?.truncated}
      index={selectedIndex}
      count={navigationEntries.length}
      group={selected.group!}
      hasNext={nextIndex >= 0}
      onPrevious={() => previewAt(selectedIndex - 1)}
      onNext={() => previewAt(nextIndex)}
      onShowCandidates={showCandidates}
      onOpen={() => openDocumentAt(selectedIndex)}
      onClose={returnToOrigin}
    />
  );
  return (
    <>
      {navigationHost && navigationBody && createPortal(navigationBody, navigationHost)}
      <section
        ref={ref}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none max-desk:overflow-auto"
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
        {session && (
          <div
            role="group"
            aria-label={t(($) => $.files.searchType)}
            className="flex flex-wrap gap-1 border-b border-border p-2"
          >
            <Button
              type="button"
              variant={view === "manual" ? "outline" : "ghost"}
              aria-pressed={view === "manual"}
              onClick={search.showSearch}
            >
              {t(($) => $.files.searchTitle)}
            </Button>
            <Button
              type="button"
              variant={view === "navigation" ? "outline" : "ghost"}
              aria-pressed={view === "navigation"}
              onClick={() => search.showCandidates()}
            >
              {t(($) => $.files.nameNavigation)}
            </Button>
          </div>
        )}
        {!navigation && (
          <form
            className="shrink-0 space-y-3 border-b border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              search.submitSearch();
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
                    onClick={() => {
                      if (mode === value) return;
                      changeSearch({ mode: value });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground max-desk:min-h-11">
                <input
                  type="checkbox"
                  checked={includeIgnored}
                  onChange={(event) => {
                    changeSearch({ includeIgnored: event.target.checked });
                  }}
                />
                {t(($) => $.files.includeIgnored)}
              </label>
              {mode === "content" && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground max-desk:min-h-11">
                  <input
                    type="checkbox"
                    checked={wholeWord}
                    onChange={(event) => {
                      changeSearch({ wholeWord: event.target.checked });
                    }}
                  />
                  {t(($) => $.files.wholeWord)}
                </label>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                ref={input}
                aria-label={t(($) => $.files.searchQuery)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={query}
                onChange={(event) => {
                  changeSearch({ query: event.target.value });
                }}
                className="min-w-0 flex-1"
              />
              <Button type="submit" disabled={disabled || !query}>
                <Search />
                {t(($) => $.common.search)}
              </Button>
              {busy && (
                <IconButton label={t(($) => $.files.cancelSearch)} onClick={() => cancel("manual")}>
                  <X />
                </IconButton>
              )}
            </div>
          </form>
        )}
        {navigation && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
              <div className="min-w-0 flex-1">
                <div tabIndex={0} className="max-h-24 overflow-auto whitespace-pre-wrap break-all">
                  {navigation.context.query}
                </div>
                {originLocation?.unmapped && (
                  <div role="status">{t(($) => $.files.navigationOriginMissing)}</div>
                )}
                {(busy || status || result?.truncated) && (
                  <div role="status">
                    {busy ? (
                      t(($) => $.files.searching)
                    ) : status?.kind === "error" ? (
                      <ErrorNotice error={status.error} />
                    ) : status?.kind === "cancelled" ? (
                      t(($) => $.common.cancelled)
                    ) : (
                      t(($) => $.files.navigationPartialMatches, { count: entries.length })
                    )}
                  </div>
                )}
              </div>
              {busy ? (
                <IconButton
                  label={t(($) => $.files.cancelSearch)}
                  onClick={() => cancel("navigation")}
                >
                  <X />
                </IconButton>
              ) : (
                !result && (
                  <IconButton
                    label={t(($) => $.common.search)}
                    disabled={disabled}
                    onClick={search.retryNavigation}
                  >
                    <Search />
                  </IconButton>
                )
              )}
            </div>
            <div
              className="flex shrink-0 border-b border-border bg-background max-desk:sticky max-desk:top-0 max-desk:z-10"
              aria-label={t(($) => $.files.navigationResults)}
            >
              {groups.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  className="flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1 px-2 text-xs hover:bg-muted max-desk:min-h-11"
                  onClick={() => locateGroup(group.key)}
                  title={`${group.label} · ${group.count}`}
                >
                  <span className="truncate">{group.label}</span>
                  <span className="shrink-0 text-muted-foreground">{group.count}</span>
                </button>
              ))}
              {result?.truncated && (
                <span
                  className="shrink-0 self-center px-1 text-[11px] text-muted-foreground"
                  title={t(($) => $.files.navigationPartialMatches, { count: entries.length })}
                  aria-label={t(($) => $.files.navigationPartialMatches, { count: entries.length })}
                >
                  {t(($) => $.files.navigationIncomplete)}
                </span>
              )}
            </div>
          </>
        )}
        <div
          tabIndex={-1}
          className="scroll-area min-h-0 flex-1 overflow-auto outline-none max-desk:flex-none max-desk:overflow-visible"
        >
          {!navigation && (busy || status || result) && (
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
          {navigation
            ? groups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <h3
                    ref={(heading) => {
                      groupHeadings.current[group.key] = heading;
                    }}
                    tabIndex={-1}
                    className="border-b border-border bg-muted px-4 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary max-desk:scroll-mt-[45px]"
                  >
                    {group.label}
                  </h3>
                  {entries
                    .slice(group.start, group.start + group.count)
                    .map((entry, index) => renderEntry(entry, group.start + index))}
                </section>
              ))
            : entries.map(renderEntry)}
        </div>
      </section>
    </>
  );
}
function MatchText({ match }: { match: SearchMatch }) {
  const { t } = useTranslation();
  const text = match.text ?? "";
  const ranges = match.ranges?.slice().sort(([left], [right]) => left - right);
  const firstMatch = ranges?.[0]?.[0] ?? 0;
  const context = Array.from(text.slice(Math.max(0, firstMatch - 24), firstMatch))
    .slice(-12)
    .join("");
  const snippetStart = firstMatch - context.length;
  // Draft candidates may carry whole lines. Bound displayed context, retaining the entire hit.
  let snippetEnd = Math.min(text.length, Math.max(snippetStart + 2048, ranges?.[0]?.[1] ?? 0));
  if (snippetEnd < text.length && text.codePointAt(snippetEnd - 1)! > 0xffff) snippetEnd--;
  const visibleRanges = ranges?.filter(([start]) => start < snippetEnd);
  let from = snippetStart;
  return (
    <span className="mt-2 block overflow-x-auto whitespace-pre font-mono text-xs text-muted-foreground">
      {snippetStart > 0 && "…"}
      {visibleRanges?.map(([start, rangeEnd], index) => {
        const end = Math.min(rangeEnd, snippetEnd);
        const plain = text.slice(from, start);
        from = end;
        return (
          <Fragment key={index}>
            {plain}
            <mark className="bg-search-match text-foreground">{text.slice(start, end)}</mark>
          </Fragment>
        );
      })}
      {text.slice(from, snippetEnd)}
      {snippetEnd < text.length && "…"}
      {(snippetStart > 0 || snippetEnd < text.length || match.truncated) && (
        <span className="ml-2 font-sans">{t(($) => $.files.snippetTruncated)}</span>
      )}
    </span>
  );
}
