import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export function codeLanguage(path: string) {
  return LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf("/") + 1));
}
