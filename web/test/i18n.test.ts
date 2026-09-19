import { afterEach, expect, test, vi } from "vitest";
import {
  browserLanguage,
  i18n,
  i18nReady,
  languagePreference,
  resources,
  setLanguagePreference,
} from "../src/i18n";
import { ApiError, errorMessage } from "../src/lib/api";

afterEach(async () => {
  await setLanguagePreference("auto");
  vi.unstubAllGlobals();
});

test("the first preferred language selects simplified Chinese only for zh tags", () => {
  for (const locale of ["zh", "zh-CN", "zh-TW", "ZH-hant-HK"])
    expect(browserLanguage(locale)).toBe("zh-CN");
  for (const locale of ["en", "en-GB", "de", "ja", "zhx", ""])
    expect(browserLanguage(locale)).toBe("en");
});

test("manual preference is stored but following the browser is not pinned", async () => {
  await i18nReady;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("navigator", { languages: ["zh-TW", "en-US"], language: "zh-TW" });
  await setLanguagePreference("en");
  expect(i18n.resolvedLanguage).toBe("en");
  expect([...values.values()]).toEqual(["en"]);
  await setLanguagePreference("auto");
  expect(languagePreference()).toBe("auto");
  expect(i18n.resolvedLanguage).toBe("zh-CN");
  expect(values.size).toBe(0);
  vi.stubGlobal("navigator", { languages: ["fr", "zh"], language: "fr" });
  await setLanguagePreference("auto");
  expect(i18n.resolvedLanguage).toBe("en");
});

test("static resources have matching keys and interpolation parameters", () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{\{(\w+)(?:,[^}]+)?\}\}/g)].map((m) => m[1]).sort();
  for (const group of Object.keys(
    resources.en.translation,
  ) as (keyof typeof resources.en.translation)[]) {
    const source = resources.en.translation[group];
    const translated = resources["zh-CN"].translation[group];
    expect(Object.keys(translated).sort(), group).toEqual(Object.keys(source).sort());
    for (const [key, value] of Object.entries(source)) {
      const translation = translated[key as keyof typeof translated];
      expect(translation, `${group}.${key}`).toBeTruthy();
      expect(placeholders(translation)).toEqual(placeholders(value));
    }
  }
});

test("interpolation preserves user text and plural selection uses the active language", async () => {
  await setLanguagePreference("en");
  expect(i18n.t(($) => $.shell.uploadStatus, { count: 1 })).toBe("1 upload");
  expect(i18n.t(($) => $.shell.uploadStatus, { count: 2 })).toBe("2 uploads");
  expect(i18n.t(($) => $.devices.terminals, { count: 1234 })).toBe("1,234 terminals");
  const path = "项目/{{count}}/<config>.txt";
  expect(i18n.t(($) => $.shell.downloadFailed, { path, error: "original" })).toContain(path);
  await setLanguagePreference("zh-CN");
  expect(i18n.t(($) => $.shell.uploadStatus, { count: 2 })).toBe("上传状态 2");
});

test("existing errors are translated at display time without changing diagnostics or metadata", async () => {
  const details = { path: "原路径" },
    result = { completed: ["one"] };
  const error = new ApiError("conflict", "original diagnostic", "unknown", details, result);
  await setLanguagePreference("en");
  expect(errorMessage(error)).toContain("The result is unknown");
  await setLanguagePreference("zh-CN");
  expect(errorMessage(error)).toContain("结果未知");
  expect(errorMessage(error)).toContain("[conflict] original diagnostic");
  expect(error).toMatchObject({
    code: "conflict",
    message: "original diagnostic",
    outcome: "unknown",
    details,
    result,
  });
  expect(errorMessage(new ApiError("unauthenticated", "bad password"), "login")).toContain(
    "登录凭据",
  );
});
