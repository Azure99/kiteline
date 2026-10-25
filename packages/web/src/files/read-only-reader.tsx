import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { standardKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { classHighlighter } from "@lezer/highlight";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { useTheme } from "../lib/appearance";
import { codeLanguage } from "../lib/code-language";
import { editorTheme } from "./editor-state";
import { editorPhrases } from "./editor-locale";

export interface ReadOnlyReaderHandle {
  openSearch(): void;
}

export function ReadOnlyReader({
  text,
  path,
  label,
  ref,
}: {
  text: string;
  path: string;
  label: string;
  ref?: Ref<ReadOnlyReaderHandle>;
}) {
  const { t, i18n } = useTranslation();
  const dark = useTheme() === "dark";
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const [appearance] = useState(() => new Compartment());
  const [phrases] = useState(() => new Compartment());
  const [language] = useState(() => new Compartment());
  const [languageError, setLanguageError] = useState<unknown>();

  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          editorTheme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0" }),
          lineNumbers(),
          drawSelection(),
          syntaxHighlighting(classHighlighter),
          keymap.of([
            ...standardKeymap,
            ...searchKeymap.map((binding) =>
              binding.key === "Escape" ? { ...binding, stopPropagation: true } : binding,
            ),
          ]),
          appearance.of([]),
          phrases.of([]),
          language.of([]),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = undefined;
    };
  }, [text, label, appearance, phrases, language]);

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
    view.current?.dispatch({
      effects: [
        appearance.reconfigure(EditorView.darkTheme.of(dark)),
        phrases.reconfigure(EditorState.phrases.of(editorPhrases())),
      ],
    });
  }, [text, label, dark, i18n.resolvedLanguage, appearance, phrases]);
  useEffect(() => {
    let active = true;
    const editor = view.current;
    const description = codeLanguage(path);
    setLanguageError(undefined);
    editor?.dispatch({ effects: language.reconfigure([]) });
    if (description && editor)
      void description.load().then(
        (support) => {
          if (active) editor.dispatch({ effects: language.reconfigure(support) });
        },
        (error) => {
          if (active) setLanguageError(error);
        },
      );
    return () => {
      active = false;
    };
  }, [text, label, path, language]);

  return (
    <>
      {!!languageError && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {t(($) => $.common.syntaxUnavailable)}: <ErrorNotice error={languageError} />
        </div>
      )}
      <div
        ref={host}
        className="isolate min-h-0 min-w-0 flex-1 overflow-hidden text-xs max-desk:text-base"
      />
    </>
  );
}
