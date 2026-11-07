import { useTranslation } from "react-i18next";
import {
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
import { editorAppearance, resizeEditorFont, syncTextTransactions } from "./editor-state";
import { editorPhrases } from "./editor-locale";
import { mapSearchPosition, searchPosition } from "./search-position";
import { diffText } from "./text-diff";

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
  openSearch(): void;
}

function scrollSnapshot(editor: EditorView) {
  const viewport = editor.scrollDOM.getBoundingClientRect();
  let left = 0;
  let top = 0;
  for (const provider of editor.state.facet(EditorView.scrollMargins)) {
    const margins = provider(editor);
    left = Math.max(left, margins?.left ?? 0);
    top = Math.max(top, margins?.top ?? 0);
  }
  left += viewport.left;
  top += viewport.top;
  const anchor = editor.posAtCoords({ x: left + 1, y: top + 1 }, false);
  const coordinates = editor.coordsAtPos(anchor);
  if (!coordinates) return;
  const line = editor.state.doc.lineAt(anchor);
  return {
    line: line.number,
    column: anchor - line.from,
    offsetX: coordinates.left - left,
    offsetY: coordinates.top - top,
  };
}

function scrollTarget(state: EditorState, snapshot: NonNullable<Draft["view"]["scrollSnapshot"]>) {
  const line = state.doc.line(Math.min(snapshot.line, state.doc.lines));
  const position = line.from + Math.min(snapshot.column, line.length);
  return EditorView.scrollIntoView(position, {
    x: "start",
    y: "start",
    xMargin: snapshot.offsetX,
    yMargin: snapshot.offsetY,
  });
}

function revealLocation(
  editor: EditorView,
  position: { line: number; column: number },
  length = 0,
) {
  const { doc } = editor.state;
  const line = doc.line(Math.max(1, Math.min(position.line, doc.lines)));
  const anchor = line.from + Math.min(position.column, line.length);
  const head = Math.min(anchor + length, doc.length);
  editor.scrollDOM.scrollLeft = 0;
  editor.dispatch({
    selection: { anchor, head },
    effects: EditorView.scrollIntoView(EditorSelection.range(anchor, head), {
      x: "nearest",
      y: "center",
    }),
  });
}

export function TextEditor({
  draft,
  store,
  wrap,
  onSave,
  location,
  onLocationFinished,
  ref,
}: {
  draft: Draft;
  store: DraftStore;
  wrap: boolean;
  onSave: () => void;
  location?: TextLocation;
  onLocationFinished(location: TextLocation): void;
  ref?: Ref<TextEditorHandle>;
}) {
  const { t, i18n } = useTranslation();

  const dark = useTheme() === "dark";
  const fontSize = useFileFontSize(useMobile());
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
  const locationFinished = useEffectEvent(onLocationFinished);
  const cancelLocation = useEffectEvent(() => {
    const request = pending.current;
    if (!request) return;
    pending.current = undefined;
    request.controller.abort();
    setLocationStatus(undefined);
    locationFinished(request.location);
  });
  useLayoutEffect(() => {
    if (!host.current || !draft.state) return;
    const editor = new EditorView({
      parent: host.current,
      state: draft.state,
      scrollTo: draft.view.scrollSnapshot
        ? scrollTarget(draft.state, draft.view.scrollSnapshot)
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save.current();
      }
    };
    editor.dom.addEventListener("keydown", keydown);
    const pointerdown = () => cancelLocation();
    editor.contentDOM.addEventListener("pointerdown", pointerdown);
    return () => {
      cancelLocation();
      editor.contentDOM.removeEventListener("pointerdown", pointerdown);
      draft.view.scrollSnapshot = scrollSnapshot(editor);
      editor.destroy();
      view.current = undefined;
    };
  }, [draft, store]);
  useImperativeHandle(
    ref,
    () => ({
      openSearch() {
        if (view.current) openSearchPanel(view.current);
      },
    }),
    [],
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
            position ? scrollTarget(draft.state, position) : undefined,
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
    if (editor && location && location.query === undefined) {
      setLocationStatus(undefined);
      revealLocation(editor, { line: location.line, column: 0 });
      locationFinished(location);
    }
  }, [location]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !location || location.query === undefined) return;
    const query = location.query;
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
        if (mapped) revealLocation(editor, mapped, query.length);
        else if (editor.root.activeElement === focus) {
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
        locationFinished(location);
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
