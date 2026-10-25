import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export const resources = { en: { translation: en }, "zh-CN": { translation: zhCN } };
export type Language = "en" | "zh-CN";
export type LanguagePreference = Language | "auto";
const storageKey = "kiteline.language";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
    enableSelector: true;
  }
}

export function browserLanguage(preferred: string): Language {
  return /^zh(?:-|$)/i.test(preferred) ? "zh-CN" : "en";
}
function detectedLanguage() {
  return browserLanguage(
    typeof navigator === "undefined" ? "en" : (navigator.languages[0] ?? navigator.language),
  );
}
function savedPreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "en" || value === "zh-CN" ? value : "auto";
  } catch {
    return "auto";
  }
}
let preference = savedPreference();
export const languagePreference = () => preference;
export const i18n = createInstance();
export const i18nReady = i18n.use(initReactI18next).init({
  resources,
  lng: preference === "auto" ? detectedLanguage() : preference,
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  fallbackLng: "en",
  defaultNS: "translation",
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export function setLanguagePreference(value: LanguagePreference) {
  preference = value;
  try {
    if (value === "auto") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, value);
  } catch {
    // A browser with storage disabled can still change this page's language.
  }
  return i18n.changeLanguage(value === "auto" ? detectedLanguage() : value);
}

if (typeof window !== "undefined") {
  const updateDocument = () => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
  };
  updateDocument();
  i18n.on("languageChanged", updateDocument);
  window.addEventListener("languagechange", () => {
    if (preference === "auto") void i18n.changeLanguage(detectedLanguage());
  });
}
