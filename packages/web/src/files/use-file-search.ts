import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { rpc } from "../lib/api";
import { newId } from "../lib/id";
import { currentRoute, isWorkspaceRoute, navigationIntent } from "../lib/navigation";
import type { CodeNavigationRequest, NavigationSearchEntry } from "./code-navigation";
import type { DraftStore } from "./drafts";
import {
  endFileNavigation,
  type FileSearchMemory,
  type FileSearchState,
  type FileSearchView,
  type NavigationSession,
  type OpenSearchEntry,
  type SearchResponse,
} from "./file-search-state";
import { beginFileNavigation, previewFileLocation, returnToFileOrigin } from "./navigation";
import { NavigationTracker } from "./navigation-tracker";

const emptyNavigationEntries: NavigationSearchEntry[] = [];
const emptyNavigationSnapshot = () => emptyNavigationEntries;
const subscribeEmptyNavigation = () => () => {};
type SearchStatus = { kind: "cancelled" } | { kind: "error"; error: unknown };
interface SearchActivity {
  busy: boolean;
  status?: SearchStatus;
}

export function useFileSearch({
  memory,
  deviceId,
  workspaceId,
  store,
  onOpen,
  onShowContent,
}: {
  memory: FileSearchMemory;
  deviceId: string;
  workspaceId: string;
  store: DraftStore;
  onOpen: OpenSearchEntry;
  onShowContent(): void;
}) {
  const [manual, setManual] = useState<FileSearchState>(
    memory.fileSearch ?? { mode: "content", query: "", includeIgnored: false, wholeWord: false },
  );
  const [nameSearch, setNameSearch] = useState(memory.fileNavigation);
  const [view, setView] = useState<FileSearchView>(memory.fileSearchView ?? "manual");
  const session = nameSearch?.session;
  const [peekVisible, setPeekVisible] = useState(
    !!session &&
      history.state?.fileNavigation?.sessionId === session.id &&
      history.state.fileNavigation.kind === "preview",
  );
  const [activity, setActivity] = useState<Record<FileSearchView, SearchActivity>>({
    manual: { busy: false },
    navigation: { busy: false },
  });
  const requests = useRef<Partial<Record<FileSearchView, AbortController>>>({});
  const entries = useSyncExternalStore(
    session?.tracker.subscribe ?? subscribeEmptyNavigation,
    session?.tracker.snapshot ?? emptyNavigationSnapshot,
  );

  useLayoutEffect(() => {
    memory.fileSearch = manual;
    memory.fileNavigation = nameSearch;
    memory.fileSearchView = view;
  }, [memory, manual, nameSearch, view]);
  useEffect(() => {
    const pending = requests.current;
    return () => {
      pending.manual?.abort();
      pending.navigation?.abort();
      delete pending.manual;
      delete pending.navigation;
    };
  }, []);

  function endNavigation() {
    requests.current.navigation?.abort();
    delete requests.current.navigation;
    endFileNavigation(memory);
    setNameSearch(undefined);
    setView("manual");
    setPeekVisible(false);
    setActivity((previous) => ({ ...previous, navigation: { busy: false } }));
  }
  const followHistory = useEffectEvent((event: PopStateEvent) => {
    if (!session) return;
    const intent = navigationIntent(event);
    if (intent === "view" || intent === "lookup") return;
    const current = history.state?.fileNavigation;
    if (
      intent === "open" ||
      !isWorkspaceRoute(currentRoute(), { deviceId, workspaceId }) ||
      current?.sessionId !== session.id
    ) {
      endNavigation();
      return;
    }
    const visible = current.kind === "preview";
    setPeekVisible(visible);
    if (visible || current.kind === "document") {
      setView("navigation");
      const entry = entries.find((item) => item.key === current.entryKey);
      if (entry) selectEntry(entry, visible);
    }
    if (visible !== peekVisible) onShowContent();
  });
  useEffect(() => {
    const listener = (event: PopStateEvent) => followHistory(event);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  function showSearch() {
    setView("manual");
    setPeekVisible(false);
  }
  function showCandidates(hidePreview = false) {
    setView("navigation");
    if (hidePreview) setPeekVisible(false);
  }
  function selectEntry(entry: NavigationSearchEntry, preview: boolean) {
    setNameSearch(
      (previous) => previous && { ...previous, selection: { entry, requestId: newId() } },
    );
    setPeekVisible(preview);
  }
  function previewAt(index: number) {
    const entry = entries[index];
    if (!session || !entry) return;
    previewFileLocation(session.id, entry.key);
    selectEntry(entry, true);
    setView("navigation");
    onShowContent();
  }
  function openDocumentAt(index: number) {
    const entry = entries[index];
    if (!session || !entry) return;
    selectEntry(entry, false);
    onOpen({
      kind: "lookup",
      entry,
      lookup: { sessionId: session.id, entryKey: entry.key },
    });
  }
  function returnToOrigin() {
    if (session && returnToFileOrigin(session.id)) return true;
    setPeekVisible(false);
    return false;
  }
  function changeSearch(changes: Partial<FileSearchState>) {
    requests.current.manual?.abort();
    delete requests.current.manual;
    setManual((previous) => ({ ...previous, ...changes, result: undefined }));
    setActivity((previous) => ({ ...previous, manual: { busy: false } }));
  }
  function cancel(owner: FileSearchView) {
    requests.current[owner]?.abort();
    delete requests.current[owner];
    setActivity((previous) => ({
      ...previous,
      [owner]: { busy: false, status: { kind: "cancelled" } },
    }));
  }
  async function search(
    owner: FileSearchView,
    options: Pick<FileSearchState, "mode" | "query" | "wholeWord" | "includeIgnored">,
    receive: (result: SearchResponse | undefined, signal: AbortSignal) => void | Promise<void>,
  ) {
    requests.current[owner]?.abort();
    const current = new AbortController();
    requests.current[owner] = current;
    const navigation = owner === "navigation" ? memory.fileNavigation?.session : undefined;
    const ownsRequest = () =>
      requests.current[owner] === current &&
      (owner !== "navigation" || memory.fileNavigation?.session === navigation);
    setActivity((previous) => ({ ...previous, [owner]: { busy: true } }));
    try {
      await receive(undefined, current.signal);
      if (!ownsRequest()) return;
      const next = await rpc(deviceId, "files.search", { workspaceId, ...options }, current.signal);
      if (!ownsRequest()) return;
      const result = { ...next, query: options.query, wholeWord: options.wholeWord };
      await receive(result, current.signal);
      if (!ownsRequest()) return;
      setActivity((previous) => ({ ...previous, [owner]: { busy: false } }));
    } catch (error) {
      if (ownsRequest())
        setActivity((previous) => ({
          ...previous,
          [owner]: { busy: false, status: { kind: "error", error } },
        }));
    } finally {
      if (requests.current[owner] === current) delete requests.current[owner];
    }
  }
  function submitSearch() {
    const { mode, query, wholeWord, includeIgnored } = manual;
    void search(
      "manual",
      { mode, query, wholeWord: mode === "content" && wholeWord, includeIgnored },
      (result) => setManual((previous) => ({ ...previous, result })),
    );
  }
  function searchNavigation(current: NavigationSession) {
    void search(
      "navigation",
      { mode: "content", query: current.context.query, wholeWord: true, includeIgnored: false },
      async (result, signal) => {
        if (memory.fileNavigation?.session !== current) return;
        await current.tracker.setResult(result, signal);
        if (signal.aborted || memory.fileNavigation?.session !== current) return;
        setNameSearch((previous) =>
          previous?.session === current ? { ...previous, result } : previous,
        );
      },
    );
  }
  function retryNavigation() {
    if (session) searchNavigation(session);
  }
  function navigateName(request: CodeNavigationRequest) {
    endFileNavigation(memory);
    const nextSession: NavigationSession = {
      ...request,
      id: newId(),
      tracker: new NavigationTracker(store, { deviceId, workspaceId }, request),
    };
    beginFileNavigation({ deviceId, workspaceId }, nextSession);
    memory.fileNavigation = { session: nextSession };
    setNameSearch(memory.fileNavigation);
    setView("navigation");
    setPeekVisible(false);
    searchNavigation(nextSession);
  }

  return {
    manual,
    nameSearch,
    session,
    view,
    peekVisible,
    activity: activity[view],
    entries,
    showSearch,
    showCandidates,
    previewAt,
    openDocumentAt,
    returnToOrigin,
    changeSearch,
    cancel,
    submitSearch,
    retryNavigation,
    navigateName,
  };
}
