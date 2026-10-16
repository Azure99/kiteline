import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export type Appearance = Theme | "system";
export interface AppearanceStore {
  getPreference(): Appearance;
  getTheme(): Theme;
  setPreference(value: Appearance): void;
  subscribe(listener: () => void): () => void;
  syncThemeColor(): void;
}

declare global {
  interface Window {
    kitelineAppearance: AppearanceStore;
  }
}

const store = window.kitelineAppearance;
export const setAppearance = store.setPreference;
export const useAppearance = () => useSyncExternalStore(store.subscribe, store.getPreference);
export const useTheme = () => useSyncExternalStore(store.subscribe, store.getTheme);
