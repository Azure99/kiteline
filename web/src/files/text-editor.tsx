import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { encodeText } from "@kiteline/shared/text";
import type { Draft, DraftStore } from "./drafts";

export function TextEditor({
  draft,
  store,
  onSave,
}: {
  draft: Draft;
  store: DraftStore;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const save = useRef(onSave);
  save.current = onSave;
  useLayoutEffect(() => {
    if (!host.current || !draft.state) return;
    const editor = new EditorView({
      parent: host.current,
      state: draft.state,
      dispatchTransactions(transactions, current) {
        for (const tr of transactions) {
          if (!tr.docChanged) continue;
          const size = encodeText(tr.newDoc.toString(), draft.format).length;
          const error = store.limitError(draft, size);
          if (error) {
            draft.notice = error;
            store.changed();
            return;
          }
        }
        current.update(transactions);
        store.update(draft, current.state);
      },
    });
    view.current = editor;
    editor.scrollDOM.scrollTop = draft.scrollTop;
    editor.scrollDOM.scrollLeft = draft.scrollLeft;
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save.current();
      }
    };
    editor.dom.addEventListener("keydown", keydown);
    return () => {
      draft.scrollTop = editor.scrollDOM.scrollTop;
      draft.scrollLeft = editor.scrollDOM.scrollLeft;
      editor.destroy();
      view.current = undefined;
    };
  }, [draft, store]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && draft.state && editor.state !== draft.state) editor.setState(draft.state);
    if (editor && draft.location) {
      const { line: number, range } = draft.location;
      draft.location = undefined;
      const line = editor.state.doc.line(Math.max(1, Math.min(number, editor.state.doc.lines)));
      const anchor = line.from + Math.min(range?.[0] ?? 0, line.length);
      const head = line.from + Math.min(range?.[1] ?? 0, line.length);
      editor.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
      });
    }
  });
  useEffect(() => {
    let active = true;
    const editor = view.current;
    const language = LanguageDescription.matchFilename(languages, draft.path);
    if (language && editor)
      void language
        .load()
        .then((support) => {
          if (active && view.current === editor)
            editor.dispatch({ effects: draft.language.reconfigure(support) });
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [draft, draft.path, draft.language]);
  return (
    <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" aria-label="文本编辑器" />
  );
}
