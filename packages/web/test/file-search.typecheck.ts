import type { NavigationSearchEntry } from "../src/files/code-navigation";
import type { OpenSearchEntry } from "../src/files/file-search-state";

export function checkSearchEntryOpen(open: OpenSearchEntry, entry: NavigationSearchEntry) {
  open({ kind: "search", entry, query: "name", wholeWord: true, focusContent: true });
  open({ kind: "lookup", entry, lookup: { sessionId: "lookup", entryKey: entry.key } });
}

export function checkSearchEntryRequest(request: Parameters<OpenSearchEntry>[0]) {
  if (request.kind === "lookup") {
    request.lookup.sessionId.toUpperCase();
    request.lookup.entryKey.toUpperCase();
    // @ts-expect-error lookup opens use candidate identity, not a search query
    void request.query;
    // @ts-expect-error lookup opens do not carry ordinary search matching options
    void request.wholeWord;
  } else {
    request.query?.toUpperCase();
    request.wholeWord.valueOf();
    // @ts-expect-error ordinary search opens do not carry an active lookup identity
    void request.lookup;
  }
}
