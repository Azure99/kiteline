import { ChangeSet, Text, type ChangeDesc, type Transaction } from "@codemirror/state";
import type { SearchMatch, SearchResult } from "@kiteline/shared/protocol";
import type { WorkspaceTarget } from "../lib/navigation";
import { type Draft, type DraftStore } from "./drafts";
import {
  navigationSearchEntries,
  type CodeNavigationRequest,
  type NavigationPositions,
  type NavigationSearchEntry,
} from "./code-navigation";
import type { NameOccurrence } from "./navigation-candidates";
import { searchPositionFinder, searchPositionMapper } from "./search-position";
import { diffText } from "./text-diff";
import type { TextLocation } from "./text-editor";

type Range = { from: number; to: number };

function unchangedRange(changes: ChangeDesc, range: Range): Range | undefined {
  let touched = false;
  changes.iterChangedRanges((from, to) => {
    if (
      (from < range.to && to > range.from) ||
      (from === to && from > range.from && from < range.to)
    )
      touched = true;
  });
  if (touched) return;
  return { from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) };
}

function occurrence(doc: Text, range: Range): NameOccurrence {
  const line = doc.lineAt(range.from);
  return {
    ...range,
    line: line.number,
    column: range.from - line.from,
    endColumn: range.to - line.from,
    lineText: line.text,
  };
}

// One composed description retains original-character identity without retaining transactions.
// Initial disk-to-dirty mapping is the only text diff; subsequent edits use their real changes.
export class NavigationDocument {
  readonly initial: Text;
  private changes: ChangeDesc;
  private current: Text;
  private valid = true;
  private findDisk?: ReturnType<typeof searchPositionFinder>;
  private mapDisk?: ReturnType<typeof searchPositionMapper>;

  constructor(
    readonly draftId: string,
    doc: Text,
    private readonly baseRaw: string,
    private readonly baseText: string,
  ) {
    this.initial = this.current = doc;
    this.changes = ChangeSet.empty(doc.length).desc;
    // A draft first loaded after rg completes is clean and can bind disk hits synchronously.
    if (doc.toString() === baseText) this.mapDisk = searchPositionMapper(doc, doc, []);
  }

  async prepareDisk(signal: AbortSignal) {
    if (this.mapDisk) return;
    const changes = await diffText(this.baseText, this.initial.toString(), signal);
    if (signal.aborted) throw new DOMException("Text comparison cancelled", "AbortError");
    this.mapDisk = searchPositionMapper(Text.of(this.baseText.split("\n")), this.initial, changes);
  }

  update(transactions: readonly Transaction[], current: Text) {
    for (const transaction of transactions) {
      if (transaction.startState.doc !== this.current) this.valid = false;
      if (this.valid && transaction.docChanged)
        this.changes = this.changes.composeDesc(transaction.changes);
      this.current = transaction.newDoc;
    }
    if (this.current !== current) this.valid = false;
  }

  invalidate() {
    const changed = this.valid;
    this.valid = false;
    return changed;
  }

  get doc() {
    return this.current;
  }

  local(range: Range): NameOccurrence | undefined {
    if (!this.valid) return;
    const mapped = unchangedRange(this.changes, range);
    return mapped && occurrence(this.current, mapped);
  }

  disk(match: SearchMatch, query: string) {
    this.findDisk ??= searchPositionFinder(this.baseRaw);
    const position = this.mapDisk?.(
      this.findDisk(match.line ?? 1, query, match.ranges?.[0]?.[0], {
        byteColumn: match.byteColumn,
        wholeWord: true,
      }),
      query,
    );
    // A disk hit that never mapped is still a search result, not a known deleted identity.
    if (!position) return { status: "unmapped" as const };
    const from = this.initial.line(position.line).from + position.column;
    const mapped = this.local({ from, to: from + query.length });
    return mapped
      ? { status: "mapped" as const, occurrence: mapped, draftId: this.draftId }
      : { status: "missing" as const };
  }

  point(position: { line: number; column: number }) {
    if (!this.valid) return;
    const line = this.initial.line(position.line);
    const mapped = this.changes.mapPos(line.from + position.column, 1);
    const currentLine = this.current.lineAt(mapped);
    return { line: currentLine.number, column: mapped - currentLine.from };
  }
}

interface TrackedDraft {
  draft: Draft;
  path: string;
  version: number;
  document: NavigationDocument;
}

export class NavigationTracker implements NavigationPositions {
  private files = new Map<string, TrackedDraft>();
  private paths = new Set<string>();
  private result?: SearchResult;
  private disposed = false;
  private entries: NavigationSearchEntry[] = [];
  private reading?: {
    key: string;
    draftId: string;
    selection: Range;
    scroll?: { position: number; offsetX: number; offsetY: number };
  };
  private listeners = new Set<() => void>();
  private stopEdits: () => void;
  private stopDrafts: () => void;

  constructor(
    private readonly store: DraftStore,
    private readonly target: WorkspaceTarget,
    private readonly request: CodeNavigationRequest,
  ) {
    // Background drafts can change while rg is pending. Capture their existing states now.
    const origin = store.find({ ...target, path: request.origin.path }, request.origin.draftId);
    if (origin?.state) this.track(origin);
    for (const draft of store.snapshot()) {
      if (this.belongs(draft) && draft.state && !this.files.has(draft.path)) this.track(draft);
    }
    this.stopEdits = store.subscribeTransactions((draft, transactions) => {
      const tracked = this.files.get(draft.path);
      if (!tracked || tracked.draft !== draft) return;
      if (transactions) {
        tracked.document.update(transactions, draft.state!.doc);
        const reading = this.reading;
        if (reading?.draftId === draft.id) {
          for (const transaction of transactions) {
            const from = transaction.changes.mapPos(reading.selection.from, 1);
            reading.selection = {
              from,
              to: Math.max(from, transaction.changes.mapPos(reading.selection.to, -1)),
            };
            if (reading.scroll)
              reading.scroll.position = transaction.changes.mapPos(reading.scroll.position, 1);
          }
        }
      } else {
        tracked.document.invalidate();
        if (this.reading?.draftId === draft.id) this.reading = undefined;
      }
      this.refresh();
    });
    this.stopDrafts = store.subscribe(() => {
      let changed = false;
      for (const tracked of this.files.values()) {
        const { draft } = tracked;
        if (
          !store.has(draft) ||
          draft.path !== tracked.path ||
          draft.sourceVersion !== tracked.version ||
          draft.state?.doc !== tracked.document.doc
        ) {
          changed = tracked.document.invalidate() || changed;
          if (this.reading?.draftId === draft.id) this.reading = undefined;
        }
      }
      for (const path of this.paths) {
        if (this.files.has(path)) continue;
        const draft = store.find({ ...target, path });
        if (draft?.state) {
          this.track(draft);
          changed = true;
        }
      }
      if (changed) this.refresh();
    });
    this.refresh();
  }

  private belongs(draft: Draft) {
    return draft.deviceId === this.target.deviceId && draft.workspaceId === this.target.workspaceId;
  }

  private track(draft: Draft) {
    this.files.set(draft.path, {
      draft,
      path: draft.path,
      version: draft.sourceVersion,
      document: new NavigationDocument(draft.id, draft.state!.doc, draft.baseRaw, draft.baseText),
    });
  }

  private refresh() {
    this.entries = navigationSearchEntries(this.result, {
      request: this.request,
      positions: this,
    });
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.entries;

  async setResult(result: SearchResult | undefined, signal: AbortSignal) {
    if (this.disposed) return;
    if (signal.aborted) throw new DOMException("Text comparison cancelled", "AbortError");
    this.result = undefined;
    const paths = new Set(result?.matches.map((match) => match.path));
    this.paths = paths;
    this.refresh();
    if (!result) return;

    // Keep disk candidates unpublished until their initial mappings are ready. Edits continue
    // to accumulate against the documents captured at lookup start while this work is pending.
    for (const path of paths) {
      if (this.disposed) return;
      if (!this.files.has(path)) {
        const draft = this.store.find({ ...this.target, path });
        if (draft?.state) this.track(draft);
      }
      const document = this.files.get(path)?.document;
      if (document) await document.prepareDisk(signal);
    }
    if (this.disposed) return;
    if (signal.aborted) throw new DOMException("Text comparison cancelled", "AbortError");

    this.result = result;
    for (const path of this.files.keys()) {
      if (path !== this.request.origin.path && !paths.has(path)) this.files.delete(path);
    }
    this.refresh();
  }

  local(range: NameOccurrence) {
    return this.files.get(this.request.origin.path)?.document.local(range);
  }

  disk(match: SearchMatch) {
    return (
      this.files.get(match.path)?.document.disk(match, this.request.context.query) ?? {
        status: "unmapped" as const,
      }
    );
  }

  private missingLocation(): TextLocation {
    return { line: 1, query: this.request.context.query, source: "draft", unmapped: true };
  }

  originLocation(): TextLocation {
    const { context, origin } = this.request;
    const document = this.files.get(origin.path)?.document;
    const range = document?.local(context.queryRange);
    if (!range) return this.missingLocation();
    const snapshot = origin.scrollSnapshot;
    const point = snapshot && document?.point(snapshot);
    return {
      line: range.line,
      column: range.column + origin.column - context.queryRange.column,
      endColumn:
        origin.endColumn === undefined
          ? undefined
          : range.column + origin.endColumn - context.queryRange.column,
      source: "draft",
      scrollSnapshot: snapshot && point ? { ...snapshot, ...point } : undefined,
    };
  }

  captureReading(key: string, location: TextLocation) {
    const entry = this.entries.find((candidate) => candidate.key === key);
    const tracked = entry && this.files.get(entry.match.path);
    if (!entry || !tracked || entry.source !== "draft") return;
    const doc = tracked.document.doc;
    const line = doc.line(location.line);
    const scroll = location.scrollSnapshot;
    this.reading = {
      key,
      draftId: tracked.draft.id,
      selection: {
        from: line.from + (location.column ?? 0),
        to: line.from + (location.endColumn ?? location.column ?? 0),
      },
      scroll: scroll && {
        position: doc.line(scroll.line).from + scroll.column,
        offsetX: scroll.offsetX,
        offsetY: scroll.offsetY,
      },
    };
  }

  entryLocation(key: string, restoreReading = false): TextLocation {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry) return this.missingLocation();
    const { match } = entry;
    const reading = this.reading;
    if (restoreReading && reading?.key === key && entry.source === "draft") {
      const doc = this.files.get(match.path)!.document.doc;
      const line = doc.lineAt(reading.selection.from);
      const scrollLine = reading.scroll && doc.lineAt(reading.scroll.position);
      return {
        line: line.number,
        column: reading.selection.from - line.from,
        endColumn: Math.min(reading.selection.to, line.to) - line.from,
        source: "draft",
        scrollSnapshot:
          reading.scroll && scrollLine
            ? {
                line: scrollLine.number,
                column: reading.scroll.position - scrollLine.from,
                offsetX: reading.scroll.offsetX,
                offsetY: reading.scroll.offsetY,
              }
            : undefined,
      };
    }
    if (entry.source === "disk" && this.files.has(match.path)) return this.missingLocation();
    return {
      line: match.line ?? 1,
      range: match.ranges?.[0],
      byteColumn: match.byteColumn,
      query: this.request.context.query,
      wholeWord: true,
      source: entry.source,
      ...(entry.source === "draft"
        ? { column: match.ranges![0]![0], endColumn: match.ranges![0]![1] }
        : {}),
    };
  }

  dispose() {
    this.disposed = true;
    this.stopEdits();
    this.stopDrafts();
    this.listeners.clear();
    this.files.clear();
    this.paths.clear();
    this.entries = [];
    this.result = undefined;
    this.reading = undefined;
  }
}
