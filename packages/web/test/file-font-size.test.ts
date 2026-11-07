import { afterEach, beforeEach, expect, test, vi } from "vitest";

const storageKey = "kiteline.file-font-size";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

async function load() {
  vi.resetModules();
  return import("../src/files/font-size");
}

test("unset sizing uses desktop and narrow defaults", async () => {
  const fonts = await load();
  expect(fonts.getFileFontSize(false)).toBe(13);
  expect(fonts.getFileFontSize(true)).toBe(16);
});

test("an explicit size stays absolute across layouts, including sizes below 16", async () => {
  const fonts = await load();
  for (const size of [10, 11, 12, 13, 15, 16, 24]) {
    fonts.setFileFontPreference(size);
    expect(fonts.getFileFontSize(false)).toBe(size);
    expect(fonts.getFileFontSize(true)).toBe(size);
  }
});

test("a saved size survives reopening and reset restores responsive defaults", async () => {
  let fonts = await load();
  fonts.setFileFontPreference(10);
  expect(localStorage.getItem(storageKey)).toBe("10");
  fonts = await load();
  expect(fonts.getFileFontSize(false)).toBe(10);
  expect(fonts.getFileFontSize(true)).toBe(10);

  fonts.setFileFontPreference(undefined);
  expect(localStorage.getItem(storageKey)).toBeNull();
  fonts = await load();
  expect(fonts.getFileFontSize(false)).toBe(13);
  expect(fonts.getFileFontSize(true)).toBe(16);
});

test("saved preferences accept only whole pixel sizes from 10 through 24", async () => {
  for (const value of ["9", "25", "10.5", "invalid"]) {
    localStorage.setItem(storageKey, value);
    const fonts = await load();
    expect(fonts.getFileFontSize(false)).toBe(13);
    expect(fonts.getFileFontSize(true)).toBe(16);
  }
  for (const value of ["10", "24"]) {
    localStorage.setItem(storageKey, value);
    const fonts = await load();
    expect(fonts.getFileFontSize(false)).toBe(Number(value));
    expect(fonts.getFileFontSize(true)).toBe(Number(value));
  }
});
