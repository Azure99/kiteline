import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { editorPhrases } from "./editor-locale";

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
  ".cm-activeLineGutter": { background: "var(--muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "#c7dce9" },
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
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      language.of(languageSupport),
      phrases.of(EditorState.phrases.of(editorPhrases())),
    ],
  });
}
