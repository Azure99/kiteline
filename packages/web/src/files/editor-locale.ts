import { i18n, resources, type Language } from "../i18n";

export const editorPhrases = () =>
  resources[(i18n.resolvedLanguage ?? "en") as Language].translation.editor;
