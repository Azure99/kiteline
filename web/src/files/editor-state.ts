import { Compartment, EditorState } from "@codemirror/state";
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
  "&": { height: "100%", fontSize: "13px", background: "var(--background)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
  ".cm-content": { padding: "12px 0", minHeight: "100%" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": {
    background: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { background: "var(--muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "#c7dce9" },
  "@media (max-width: 959px)": { "&": { fontSize: "16px" } },
});

export function textState(text: string, language: Compartment, phrases = new Compartment()) {
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
      language.of([]),
      phrases.of(EditorState.phrases.of(editorPhrases())),
    ],
  });
}
