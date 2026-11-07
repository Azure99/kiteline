import { useSyncExternalStore } from "react";

const storageKey = "kiteline.file-font-size";
export const minFileFontPreference = 10;
export const maxFileFontPreference = 24;

function readPreference() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === null) return;
    const value = Number(saved);
    if (Number.isInteger(value) && value >= minFileFontPreference && value <= maxFileFontPreference)
      return value;
  } catch (error) {
    console.warn("Could not read file font size preference; using default sizes.", error);
  }
}

let preference = readPreference();
const listeners = new Set<() => void>();

function getFileFontPreference() {
  return preference;
}

export function fileFontSize(mobile: boolean, value: number | undefined) {
  return value ?? (mobile ? 16 : 13);
}

export function getFileFontSize(mobile: boolean) {
  return fileFontSize(mobile, preference);
}

export function setFileFontPreference(value: number | undefined) {
  preference = value;
  try {
    if (value === undefined) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(value));
  } catch (error) {
    console.warn("Could not save file font size preference; applied to this page only.", error);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFileFontPreference() {
  return useSyncExternalStore(subscribe, getFileFontPreference);
}

export function useFileFontSize(mobile: boolean) {
  return fileFontSize(mobile, useFileFontPreference());
}
