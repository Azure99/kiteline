import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type StateEffect,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { searchKeymap } from "@codemirror/search";
import { editorPhrases } from "./editor-locale";

export const editorAppearance = new Compartment();
const editorHistory = new Compartment();

// Restoring the vertical position can reveal a wider line after scrollIntoView writes scrollLeft.
// Reapply the horizontal anchor once the restored viewport has been measured.
const restoreHorizontalScroll = EditorView.scrollHandler.of((view, range, options) => {
  if (!range.empty || options.x !== "start" || options.y !== "start") return false;

  view.requestMeasure({
    read(current) {
      const coordinates = current.coordsAtPos(range.head);
      if (!coordinates) return undefined;

      let leftMargin = 0;
      for (const provider of current.state.facet(EditorView.scrollMargins)) {
        leftMargin = Math.max(leftMargin, provider(current)?.left ?? 0);
      }
      const viewport = current.scrollDOM.getBoundingClientRect();
      return (
        current.scrollDOM.scrollLeft +
        (coordinates.left - viewport.left - leftMargin - options.xMargin) / current.scaleX
      );
    },
    write(left, current) {
      if (left !== undefined) current.scrollDOM.scrollLeft = left;
    },
  });
  return false;
});

// CodeMirror remeasures a resized editor, but only explicit scroll requests reveal its selection.
const revealAfterResize = ViewPlugin.define(() => ({ height: 0 }), {
  provide: (plugin) =>
    EditorView.updateListener.of((update) => {
      if (!update.geometryChanged) return;
      const state = update.view.plugin(plugin)!;
      const height = update.view.scrollDOM.clientHeight;
      const shrank = height < state.height;
      state.height = height;
      if (shrank && update.view.hasFocus)
        update.view.dispatch({
          effects: EditorView.scrollIntoView(update.state.selection.main),
        });
    }),
});

export const editorTheme = EditorView.theme({
  "&": { height: "100%", background: "var(--background)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
  ".cm-content": { padding: "12px 0", minHeight: "100%" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": {
    background: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    { background: "var(--code-selection)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-panels": {
    background: "var(--muted)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-textfield": { background: "var(--background)", borderColor: "var(--border)" },
  ".cm-button, .cm-button:active": {
    background: "var(--background)",
    borderColor: "var(--border)",
  },
  "@media (max-width: 959px)": {
    ".cm-panel.cm-search": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      paddingRight: "52px",
    },
    ".cm-panel.cm-search .cm-textfield": {
      fontSize: "16px",
      flex: "1 1 100px",
      minWidth: "0",
    },
    // Browsers render br as a line break, so its flex-basis cannot separate the Replace row.
    ".cm-panel.cm-search > br": { display: "none" },
    ".cm-panel.cm-search::after": { content: '""', flexBasis: "100%" },
    ".cm-panel.cm-search [name=replace], .cm-panel.cm-search [name=replaceAll]": { order: "1" },
    ".cm-panel.cm-search [name=close]": { width: "44px", height: "44px" },
  },
  ".cm-activeLine": { background: "var(--code-active)" },
  ".cm-searchMatch": { background: "var(--search-match)" },
  ".cm-searchMatch-selected": { outline: "1px solid var(--primary)" },
});

export function resizeEditorFont(editor: EditorView, size: number) {
  const fontSize = `${size}px`;
  if (editor.dom.style.fontSize === fontSize) return;
  // Capture the line anchor before a smaller font can clamp scrollTop.
  const position = editor.scrollSnapshot();
  editor.dom.style.fontSize = fontSize;
  editor.dispatch({ effects: position });
}

export function textState(
  text: string,
  language: Compartment,
  phrases: Compartment,
  languageSupport: Extension = [],
) {
  return EditorState.create({
    doc: text,
    extensions: [
      editorTheme,
      restoreHorizontalScroll,
      revealAfterResize,
      editorAppearance.of([]),
      lineNumbers(),
      editorHistory.of(history()),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      syntaxHighlighting(classHighlighter),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      language.of(languageSupport),
      phrases.of(EditorState.phrases.of(editorPhrases())),
    ],
  });
}

export function syncTextTransactions(
  state: EditorState,
  text: string | Text,
  selection?: EditorSelection,
  scrollTo?: StateEffect<unknown>,
) {
  // Removing the history field prevents old undo/redo from writing into the new disk text.
  const replaced = state.update({
    changes: { from: 0, to: state.doc.length, insert: text },
    effects: editorHistory.reconfigure([]),
  });
  const position = (offset: number) => {
    const previous = state.doc.lineAt(offset);
    const current = replaced.state.doc.line(Math.min(previous.number, replaced.state.doc.lines));
    return current.from + Math.min(offset - previous.from, current.length);
  };
  const restored = replaced.state.update({
    selection:
      selection ??
      EditorSelection.create(
        state.selection.ranges.map((range) =>
          EditorSelection.range(position(range.anchor), position(range.head)),
        ),
        state.selection.mainIndex,
      ),
    effects: [editorHistory.reconfigure(history()), ...(scrollTo ? [scrollTo] : [])],
  });
  return [replaced, restored] as const;
}
