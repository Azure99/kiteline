import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection, EditorState, Text, Transaction } from "@codemirror/state";
import { openSearchPanel, SearchQuery, setSearchQuery } from "@codemirror/search";
import { codeLanguage } from "../lib/code-language";
import { ErrorNotice } from "../components/error-notice";
import { encodeText } from "@kiteline/shared/protocol/text";
import type { Draft, DraftStore } from "./drafts";
import { useTheme } from "../lib/appearance";
import { isMobile, useMobile } from "../lib/use-mobile";
import { getFileFontSize, useFileFontSize } from "./font-size";
import {
  editorAppearance,
  resizeEditorFont,
  scrollSnapshot,
  scrollTarget,
  syncTextTransactions,
} from "./editor-state";
import { editorPhrases } from "./editor-locale";
import { mapSearchPosition, searchPosition } from "./search-position";
import { diffText } from "./text-diff";
import { navigationQuery } from "./navigation-query";
import { inspectNavigation } from "./navigation-candidates";
import type { CodeNavigationRequest } from "./code-navigation";

export interface TextLocation {
  line: number;
  range?: [number, number];
  query?: string;
  column?: number;
  endColumn?: number;
  wholeWord?: boolean;
  byteColumn?: number;
  source?: "draft" | "disk";
  unmapped?: boolean;
  scrollSnapshot?: Draft["view"]["scrollSnapshot"];
}

export interface TextEditorHandle {
  focus(): void;
  openSearch(): void;
  navigationQuery(): string | undefined;
  navigateName(initialGroup: CodeNavigationRequest["initialGroup"]): void;
}

function locationRange(
  doc: Text,
  position: Pick<TextLocation, "line" | "column" | "endColumn">,
  length = 0,
) {
  const line = doc.line(Math.max(1, Math.min(position.line, doc.lines)));
  const anchor = line.from + Math.min(position.column ?? 0, line.length);
  const head =
    position.endColumn === undefined
      ? Math.min(anchor + length, doc.length)
      : line.from + Math.min(position.endColumn, line.length);
  return { anchor, head };
}

function revealLocation(
  editor: EditorView,
  position: Pick<TextLocation, "line" | "column" | "endColumn" | "scrollSnapshot">,
  length = 0,
) {
  const { anchor, head } = locationRange(editor.state.doc, position, length);
  if (!position.scrollSnapshot) editor.scrollDOM.scrollLeft = 0;
  editor.dispatch({
    selection: { anchor, head },
    effects: position.scrollSnapshot
      ? scrollTarget(editor.state.doc, position.scrollSnapshot)
      : EditorView.scrollIntoView(EditorSelection.range(anchor, head), {
          x: "nearest",
          y: "center",
        }),
  });
}

function openLocationSearch(editor: EditorView, query: string) {
  openSearchPanel(editor);
  editor.dispatch({
    effects: setSearchQuery.of(
      new SearchQuery({
        search: query
          .replaceAll("\\", "\\\\")
          .replaceAll("\n", "\\n")
          .replaceAll("\r", "\\r")
          .replaceAll("\t", "\\t"),
        caseSensitive: true,
      }),
    ),
  });
}

export function TextEditor({
  draft,
  store,
  wrap,
  onSave,
  onNavigateName,
  onReadingLocation,
  location,
  onLocationFinished,
  ref,
}: {
  draft: Draft;
  store: DraftStore;
  wrap: boolean;
  onSave: () => void;
  location?: TextLocation;
  onNavigateName?(request: CodeNavigationRequest): void;
  onReadingLocation?(location: TextLocation): void;
  onLocationFinished(location: TextLocation, focusEditor?: () => void): void;
  ref?: Ref<TextEditorHandle>;
}) {
  const { t, i18n } = useTranslation();

  const dark = useTheme() === "dark";
  const fontSize = useFileFontSize(useMobile());
  const [locationMissing, setLocationMissing] = useState(false);
  const [languageError, setLanguageError] = useState<unknown>();
  const [locationStatus, setLocationStatus] = useState<
    { kind: "pending" } | { kind: "error"; error: unknown }
  >();
  const pending = useRef<{ location: TextLocation; controller: AbortController }>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const sourceVersion = useRef(draft.sourceVersion);
  const save = useRef(onSave);
  save.current = onSave;
  const navigateName = useRef(onNavigateName);
  navigateName.current = onNavigateName;
  const locationFinished = useEffectEvent(onLocationFinished);
  const cancelLocation = useEffectEvent(() => {
    const request = pending.current;
    if (!request) return;
    pending.current = undefined;
    request.controller.abort();
    setLocationStatus(undefined);
    locationFinished(request.location);
  });
  const reportReading = useEffectEvent((editor: EditorView) => {
    if (!onReadingLocation) return;
    const selection = editor.state.selection.main;
    const line = editor.state.doc.lineAt(selection.from);
    onReadingLocation({
      line: line.number,
      column: selection.from - line.from,
      endColumn: Math.min(selection.to, line.to) - line.from,
      source: "draft",
      scrollSnapshot: scrollSnapshot(editor),
    });
  });
  const requestNavigation = useCallback(
    (editor: EditorView, initialGroup: CodeNavigationRequest["initialGroup"]) => {
      if (!navigateName.current) return;
      const query = navigationQuery(editor.state);
      if (query === undefined) return;
      const context = inspectNavigation(editor.state, query);
      const selection = editor.state.selection.main;
      const originLine = editor.state.doc.lineAt(selection.from);
      navigateName.current?.({
        initialGroup,
        context,
        origin: {
          path: draft.path,
          draftId: draft.id,
          line: originLine.number,
          column: selection.from - originLine.from,
          endColumn: Math.min(selection.to, originLine.to) - originLine.from,
          scrollSnapshot: scrollSnapshot(editor),
        },
      });
    },
    [draft],
  );
  useLayoutEffect(() => {
    if (!host.current || !draft.state) return;
    const editor = new EditorView({
      parent: host.current,
      state: draft.state,
      scrollTo: draft.view.scrollSnapshot
        ? scrollTarget(draft.state.doc, draft.view.scrollSnapshot)
        : undefined,
      dispatchTransactions(transactions, current) {
        // Undo can bypass transaction filters; reject before updating either the document or history.
        let measured: { text: string; bytes: number } | undefined;
        for (const tr of transactions) {
          if (!tr.docChanged) continue;
          const text = tr.newDoc.toString();
          measured = { text, bytes: encodeText(text, draft.format).length };
          if (!store.acceptEdit(draft, measured.bytes)) return;
        }
        current.update(transactions);
        store.update(draft, current.state, measured, transactions);
        if (transactions.some((tr) => tr.docChanged || tr.selection)) reportReading(current);
        if (
          transactions.some(
            (tr) =>
              tr.isUserEvent("select") ||
              (tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined),
          )
        )
          cancelLocation();
      },
    });
    editor.dom.style.fontSize = `${getFileFontSize(isMobile())}px`;
    view.current = editor;
    sourceVersion.current = draft.sourceVersion;
    const keydown = (event: KeyboardEvent) => {
      if (
        navigateName.current &&
        event.key === "F12" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        editor.contentDOM.contains(event.target as Node)
      ) {
        event.preventDefault();
        requestNavigation(editor, event.shiftKey ? "occurrences" : "definitions");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save.current();
      }
    };
    const mousedown = (event: MouseEvent) => {
      if (
        !navigateName.current ||
        event.button !== 0 ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (!editor.contentDOM.contains(event.target as Node)) return;
      const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return;
      event.preventDefault();
      editor.dispatch({ selection: { anchor: position } });
      requestNavigation(editor, "definitions");
    };
    editor.dom.addEventListener("keydown", keydown);
    editor.dom.addEventListener("mousedown", mousedown);
    const scroll = () => reportReading(editor);
    editor.scrollDOM.addEventListener("scroll", scroll);
    const pointerdown = () => cancelLocation();
    editor.contentDOM.addEventListener("pointerdown", pointerdown);
    return () => {
      cancelLocation();
      editor.contentDOM.removeEventListener("pointerdown", pointerdown);
      editor.scrollDOM.removeEventListener("scroll", scroll);
      draft.view.scrollSnapshot = scrollSnapshot(editor);
      editor.destroy();
      view.current = undefined;
    };
  }, [draft, store, requestNavigation]);
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        view.current?.focus();
      },
      navigateName(initialGroup) {
        if (view.current) requestNavigation(view.current, initialGroup);
      },
      navigationQuery() {
        return view.current ? navigationQuery(view.current.state) : undefined;
      },
      openSearch() {
        if (view.current) openSearchPanel(view.current);
      },
    }),
    [requestNavigation],
  );
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor) resizeEditorFont(editor, fontSize);
  }, [fontSize]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (
      editor &&
      (sourceVersion.current !== draft.sourceVersion ||
        (draft.state && editor.state.doc !== draft.state.doc))
    )
      cancelLocation();
    if (editor && draft.state && editor.state !== draft.state) {
      if (sourceVersion.current === draft.sourceVersion) {
        const position = scrollSnapshot(editor);
        editor.update(
          syncTextTransactions(
            editor.state,
            draft.state.doc,
            draft.state.selection,
            position ? scrollTarget(draft.state.doc, position) : undefined,
          ),
        );
        store.update(draft, editor.state);
      } else editor.setState(draft.state);
    }
    sourceVersion.current = draft.sourceVersion;
    if (
      editor &&
      (editor.state.facet(EditorView.darkTheme) !== dark || editor.lineWrapping !== wrap)
    )
      editor.dispatch({
        effects: editorAppearance.reconfigure([
          EditorView.darkTheme.of(dark),
          wrap ? EditorView.lineWrapping : [],
        ]),
      });
  });
  useLayoutEffect(() => {
    const editor = view.current;
    editor?.dispatch({
      effects: draft.phrases.reconfigure(EditorState.phrases.of(editorPhrases())),
    });
  }, [draft, i18n.resolvedLanguage]);
  useLayoutEffect(() => {
    if (pending.current && pending.current.location !== location) cancelLocation();
    const editor = view.current;
    if (editor && location && (location.query === undefined || location.source === "draft")) {
      setLocationStatus(undefined);
      const { query } = location;
      const range = locationRange(editor.state.doc, location, query?.length ?? 0);
      let focusEditor: (() => void) | undefined;
      if (
        query !== undefined &&
        (location.unmapped || editor.state.sliceDoc(range.anchor, range.head) !== query)
      ) {
        setLocationMissing(true);
        openLocationSearch(editor, query);
      } else {
        setLocationMissing(false);
        revealLocation(editor, location, query?.length ?? 0);
        focusEditor = () => editor.focus();
      }
      locationFinished(location, focusEditor);
    }
  }, [location]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !location || location.query === undefined || location.source === "draft") return;
    const query = location.query;
    setLocationMissing(false);
    const request = { location, controller: new AbortController() };
    const doc = editor.state.doc;
    const version = draft.sourceVersion;
    const baseText = draft.baseText;
    const base = Text.of(baseText.split("\n"));
    const parsed = searchPosition(draft.baseRaw, location.line, query, location.range?.[0], {
      wholeWord: location.wholeWord,
      byteColumn: location.byteColumn,
    });
    const found = mapSearchPosition(base, base, parsed, query, []);
    // Parent layout effects finish the opening command's own focus handoff before this effect.
    const focus = editor.root.activeElement;
    pending.current = request;
    setLocationStatus({ kind: "pending" });
    const changes = found
      ? diffText(baseText, doc.toString(), request.controller.signal)
      : Promise.resolve([]);
    void changes.then(
      (computed) => {
        if (pending.current !== request) return;
        if (
          view.current !== editor ||
          editor.state.doc !== doc ||
          draft.sourceVersion !== version
        ) {
          cancelLocation();
          return;
        }
        const mapped = mapSearchPosition(base, doc, found, query, computed);
        pending.current = undefined;
        setLocationStatus(undefined);
        let focusEditor: (() => void) | undefined;
        if (mapped) {
          revealLocation(editor, mapped, query.length);
          focusEditor = () => editor.focus();
        } else if (editor.root.activeElement === focus) {
          setLocationMissing(true);
          openLocationSearch(editor, query);
        }
        locationFinished(location, focusEditor);
      },
      (error: unknown) => {
        if (pending.current !== request) return;
        pending.current = undefined;
        setLocationStatus({ kind: "error", error });
        locationFinished(location);
      },
    );
    return () => {
      if (pending.current === request) cancelLocation();
    };
  }, [location, draft]);
  useEffect(() => {
    let active = true;
    const editor = view.current;
    const language = codeLanguage(draft.path);
    setLanguageError(undefined);
    editor?.dispatch({ effects: draft.language.reconfigure([]) });
    if (language && editor)
      void language
        .load()
        .then((support) => {
          if (active && view.current === editor)
            editor.dispatch({ effects: draft.language.reconfigure(support) });
        })
        .catch((error) => {
          if (active && view.current === editor) setLanguageError(error);
        });
    return () => {
      active = false;
    };
  }, [draft, draft.path, draft.language]);
  return (
    <>
      {locationMissing && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {t(($) => $.files.peekLocationMissing)}
        </div>
      )}
      {locationStatus && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {locationStatus.kind === "pending" ? (
            t(($) => $.common.loading)
          ) : (
            <ErrorNotice error={locationStatus.error} />
          )}
        </div>
      )}
      {!!languageError && (
        <div role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {t(($) => $.common.syntaxUnavailable)}: <ErrorNotice error={languageError} />
        </div>
      )}
      <div
        ref={host}
        className="isolate min-h-0 min-w-0 flex-1 overflow-hidden max-desk:min-h-12"
        aria-label={t(($) => $.files.editor)}
      />
    </>
  );
}
