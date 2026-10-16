import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
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

const theme = EditorView.theme({
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
  ".cm-activeLine": { background: "var(--code-active)" },
  ".cm-searchMatch": { background: "var(--search-match)" },
  ".cm-searchMatch-selected": { outline: "1px solid var(--primary)" },
});

export function textState(
  text: string,
  language: Compartment,
  phrases = new Compartment(),
  languageSupport: Extension = [],
) {
  return EditorState.create({
    doc: text,
    extensions: [
      theme,
      editorAppearance.of([]),
      lineNumbers(),
      history(),
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
