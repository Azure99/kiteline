import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { openSearchPanel, SearchQuery, setSearchQuery } from "@codemirror/search";
import { codeLanguage } from "../lib/code-language";
import { ErrorNotice } from "../components/error-notice";
import { encodeText } from "@kiteline/shared/protocol/text";
import type { Draft, DraftStore } from "./drafts";
import { useTheme } from "../lib/appearance";
import { editorAppearance } from "./editor-state";
import { editorPhrases } from "./editor-locale";

export function TextEditor({
  draft,
  store,
  onSave,
}: {
  draft: Draft;
  store: DraftStore;
  onSave: () => void;
}) {
  const { t, i18n } = useTranslation();

  const dark = useTheme() === "dark";
  const [languageError, setLanguageError] = useState<unknown>();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const save = useRef(onSave);
  save.current = onSave;
  useLayoutEffect(() => {
    if (!host.current || !draft.state) return;
    const editor = new EditorView({
      parent: host.current,
      state: draft.state,
      scrollTo: draft.scrollSnapshot,
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
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save.current();
      }
    };
    editor.dom.addEventListener("keydown", keydown);
    return () => {
      draft.scrollSnapshot = editor.scrollSnapshot();
      editor.destroy();
      view.current = undefined;
    };
  }, [draft, store]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && draft.state && editor.state !== draft.state) editor.setState(draft.state);
    if (editor && editor.state.facet(EditorView.darkTheme) !== dark)
      editor.dispatch({ effects: editorAppearance.reconfigure(EditorView.darkTheme.of(dark)) });
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
