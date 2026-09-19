import { Compartment, EditorState } from "@codemirror/state";
import { getDialog, type EditorView } from "@codemirror/view";
import { i18n, resources, type Language } from "../i18n";

export const editorPhrases = () =>
  resources[(i18n.resolvedLanguage ?? "en") as Language].translation.editor;

const controlsSelector =
  ".cm-search input, .cm-search button, .cm-goto-line input, .cm-goto-line button";

export function updateEditorLocale(view: EditorView, phrases: Compartment) {
  const translated = editorPhrases();
  if (view.state.facet(EditorState.phrases).includes(translated)) return;
  const controls = [
    ...view.dom.querySelectorAll<HTMLInputElement | HTMLButtonElement>(controlsSelector),
  ];
  const fields = controls.map((node) =>
    node instanceof HTMLInputElement
      ? {
          value: node.value,
          checked: node.checked,
          scrollLeft: node.scrollLeft,
          start: node.selectionStart,
          end: node.selectionEnd,
          direction: node.selectionDirection,
        }
      : undefined,
  );
  const active = view.root.activeElement;
  const focused = controls.findIndex((node) => node === active);
  const editorFocused = view.hasFocus;
  const scroll = view.scrollSnapshot();

  // Phrases changes rebuild CodeMirror's panels, while preserving the EditorState.
  view.dispatch({ effects: phrases.reconfigure(EditorState.phrases.of(translated)) });
  const next = [
    ...view.dom.querySelectorAll<HTMLInputElement | HTMLButtonElement>(controlsSelector),
  ];
  for (const [index, saved] of fields.entries()) {
    const input = next[index];
    if (!saved || !(input instanceof HTMLInputElement)) continue;
    input.value = saved.value;
    input.checked = saved.checked;
    if (saved.start !== null && saved.end !== null)
      input.setSelectionRange(saved.start, saved.end, saved.direction ?? undefined);
    input.scrollLeft = saved.scrollLeft;
  }
  // gotoLine retains its original config and result callback across the view refresh.
  const dialog = getDialog(view, "cm-goto-line");
  if (dialog) {
    for (const node of dialog.dom.querySelector("label")?.childNodes ?? [])
      if (node.nodeType === Node.TEXT_NODE) node.nodeValue = view.state.phrase("Go to line") + ": ";
    const button = dialog.dom.querySelector('button[type="submit"]');
    if (button) button.textContent = view.state.phrase("go");
  }
  if (focused >= 0) next[focused]?.focus({ preventScroll: true });
  else if (editorFocused) view.focus();
  else {
    if (view.root.activeElement instanceof HTMLElement) view.root.activeElement.blur();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
  }
  view.dispatch({ effects: scroll });
}
