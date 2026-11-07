import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Text,
  type Transaction,
} from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { standardKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, SearchQuery, searchKeymap, setSearchQuery } from "@codemirror/search";
import { classHighlighter } from "@lezer/highlight";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "../components/error-notice";
import { useTheme } from "../lib/appearance";
import { isMobile, useMobile } from "../lib/use-mobile";
import { codeLanguage } from "../lib/code-language";
import {
  editorTheme,
  editorScrollRestoration,
  resizeEditorFont,
  scrollSnapshot,
  scrollTarget,
  selectionForDocument,
} from "./editor-state";
import { editorPhrases } from "./editor-locale";
import { getFileFontSize, useFileFontSize } from "./font-size";

export interface ReaderLocation {
  line: number;
  query: string;
  column?: number;
  unmapped?: boolean;
  align?: "start" | "center";
}

export interface ReadOnlyReaderHandle {
  openSearch(): void;
  applyTransactions(transactions: readonly Transaction[]): void;
}

export function ReadOnlyReader({
  text,
  path,
  label,
  location,
  locationRequestId,
  ref,
}: {
  text: string | Text;
  path: string;
  label: string;
  location?: ReaderLocation;
  locationRequestId?: string;
  ref?: Ref<ReadOnlyReaderHandle>;
}) {
  const { t, i18n } = useTranslation();
  const dark = useTheme() === "dark";
  const mobile = useMobile();
  const fontSize = useFileFontSize(mobile);
  const document = useMemo(
    () => (typeof text === "string" ? Text.of(text.split("\n")) : text),
    [text],
  );
  const sourceDoc = useRef(document);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const [appearance] = useState(() => new Compartment());
  const [phrases] = useState(() => new Compartment());
  const [language] = useState(() => new Compartment());
  const [languageError, setLanguageError] = useState<unknown>();
  const [locationMissing, setLocationMissing] = useState(false);
  const currentDocument = useEffectEvent(() => document);

  useLayoutEffect(() => {
    if (!host.current) return;
    const initialDocument = currentDocument();
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDocument,
        extensions: [
          editorTheme,
          editorScrollRestoration,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
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
    editor.dom.style.fontSize = `${getFileFontSize(isMobile())}px`;
    view.current = editor;
    sourceDoc.current = initialDocument;
    return () => {
      editor.destroy();
      view.current = undefined;
    };
  }, [path, appearance, phrases, language]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || sourceDoc.current === document) return;
    const snapshot = scrollSnapshot(editor);
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: document },
      selection: selectionForDocument(editor.state, document),
      effects: snapshot ? scrollTarget(document, snapshot) : [],
    });
    sourceDoc.current = document;
  }, [document, path]);

  useImperativeHandle(
    ref,
    () => ({
      openSearch() {
        if (view.current) openSearchPanel(view.current);
      },
      applyTransactions(transactions) {
        const editor = view.current;
        const first = transactions[0];
        if (!editor || !first || first.startState.doc !== sourceDoc.current) return;
        let changes = first.changes;
        for (const transaction of transactions.slice(1))
          changes = changes.compose(transaction.changes);
        editor.dispatch({ changes, effects: editor.scrollSnapshot().map(changes) });
        sourceDoc.current = transactions[transactions.length - 1]!.newDoc;
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor) resizeEditorFont(editor, fontSize);
  }, [fontSize, path]);
  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: [
        appearance.reconfigure([
          EditorView.darkTheme.of(dark),
          EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0" }),
        ]),
      ],
    });
  }, [path, label, dark, appearance]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const position = editor.scrollSnapshot();
    editor.dispatch({ effects: phrases.reconfigure(EditorState.phrases.of(editorPhrases())) });
    // Changing phrases rebuilds CodeMirror's document view; that dispatch does not apply scroll effects.
    editor.dispatch({ effects: position });
  }, [path, i18n.resolvedLanguage, phrases]);
  const resolveLocation = useEffectEvent(() => {
    const editor = view.current;
    if (!editor || !location || location.unmapped) return;
    const line =
      location.line <= editor.state.doc.lines ? editor.state.doc.line(location.line) : undefined;
    const anchor =
      line && location.column !== undefined && location.column <= line.length
        ? line.from + location.column
        : undefined;
    const head = anchor === undefined ? undefined : anchor + location.query.length;
    if (
      anchor === undefined ||
      head === undefined ||
      head > editor.state.doc.length ||
      editor.state.sliceDoc(anchor, head) !== location.query
    )
      return;
    return { anchor, head };
  });
  useLayoutEffect(() => {
    setLocationMissing(!!location && !resolveLocation());
  }, [path, document, location]);
  const applyLocation = useEffectEvent(() => {
    const editor = view.current;
    if (!editor || !location) return;
    const target = resolveLocation();
    if (!target) {
      openSearchPanel(editor);
      editor.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: location.query
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
    const { anchor, head } = target;
    editor.scrollDOM.scrollLeft = 0;
    editor.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(EditorSelection.range(anchor, head), {
        x: "nearest",
        y: location.align ?? "center",
        yMargin: location.align === "start" ? editor.defaultLineHeight * 2 : 5,
      }),
    });
  });
  useLayoutEffect(() => {
    applyLocation();
  }, [path, locationRequestId]);
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
  }, [path, language]);

  return (
    <>
      {locationMissing && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {t(($) => $.files.peekLocationMissing)}
        </div>
      )}
      {!!languageError && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {t(($) => $.common.syntaxUnavailable)}: <ErrorNotice error={languageError} />
        </div>
      )}
      <div ref={host} className="isolate min-h-0 min-w-0 flex-1 overflow-hidden" />
    </>
  );
}
