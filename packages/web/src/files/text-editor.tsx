import { useTranslation } from "react-i18next";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { openSearchPanel, SearchQuery, setSearchQuery } from "@codemirror/search";
import { codeLanguage } from "../lib/code-language";
import { ErrorNotice } from "../components/error-notice";
import { encodeText } from "@kiteline/shared/protocol/text";
import type { Draft, DraftStore } from "./drafts";
import { useTheme } from "../lib/appearance";
import { editorAppearance, syncTextTransactions } from "./editor-state";
import { editorPhrases } from "./editor-locale";

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

function scrollTarget(state: EditorState, snapshot: NonNullable<Draft["scrollSnapshot"]>) {
  const line = state.doc.line(Math.min(snapshot.line, state.doc.lines));
  const position = line.from + Math.min(snapshot.column, line.length);
  return EditorView.scrollIntoView(position, {
    x: "start",
    y: "start",
    xMargin: snapshot.offsetX,
    yMargin: snapshot.offsetY,
  });
}

export function TextEditor({
  draft,
  store,
  wrap,
  onSave,
  ref,
}: {
  draft: Draft;
  store: DraftStore;
  wrap: boolean;
  onSave: () => void;
  ref?: Ref<TextEditorHandle>;
}) {
  const { t, i18n } = useTranslation();

  const dark = useTheme() === "dark";
  const [languageError, setLanguageError] = useState<unknown>();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const sourceVersion = useRef(draft.sourceVersion);
  const save = useRef(onSave);
  save.current = onSave;
  useLayoutEffect(() => {
    if (!host.current || !draft.state) return;
    const editor = new EditorView({
      parent: host.current,
      state: draft.state,
      scrollTo: draft.scrollSnapshot ? scrollTarget(draft.state, draft.scrollSnapshot) : undefined,
      dispatchTransactions(transactions, current) {
        // Undo can bypass transaction filters; reject before updating either the document or history.
        let measured: { text: string; bytes: number } | undefined;
        for (const tr of transactions) {
          if (!tr.docChanged) continue;
          const text = tr.newDoc.toString();
          measured = { text, bytes: encodeText(text, draft.format).length };
          const error = store.limitError(draft, measured.bytes);
          if (error) {
            draft.notice = error;
            store.changed();
            return;
          }
        }
        current.update(transactions);
        store.update(draft, current.state, measured);
      },
    });
    view.current = editor;
    sourceVersion.current = draft.sourceVersion;
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save.current();
      }
    };
    editor.dom.addEventListener("keydown", keydown);
    return () => {
      draft.scrollSnapshot = scrollSnapshot(editor);
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
    const editor = view.current;
    if (editor && draft.location) {
      const { line: number, range, query } = draft.location;
      draft.location = undefined;
      const line = editor.state.doc.line(Math.max(1, Math.min(number, editor.state.doc.lines)));
      const anchor = line.from + Math.min(range?.[0] ?? 0, line.length);
      const head = line.from + Math.min(range?.[1] ?? 0, line.length);
      if (query !== undefined && (!range || editor.state.doc.sliceString(anchor, head) !== query)) {
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
        return;
      }
      editor.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
      });
    }
  });
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
      {!!languageError && (
        <div role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {t(($) => $.common.syntaxUnavailable)}: <ErrorNotice error={languageError} />
        </div>
      )}
      <div
        ref={host}
        className="isolate min-h-0 min-w-0 flex-1 overflow-hidden text-[13px] max-desk:min-h-12 max-desk:text-[16px]"
        aria-label={t(($) => $.files.editor)}
      />
    </>
  );
}
