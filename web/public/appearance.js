// @ts-check
(() => {
  const key = "kiteline.appearance";
  const system = matchMedia("(prefers-color-scheme: dark)");
  /** @type {import("../src/lib/appearance").Appearance} */
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") preference = saved;
  } catch (error) {
    console.warn("Could not read appearance preference; using system appearance.", error);
  }
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @returns {import("../src/lib/appearance").Theme} */
  function getTheme() {
    return preference === "system" ? (system.matches ? "dark" : "light") : preference;
  }
  function syncThemeColor() {
    const background = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    // The head script runs before Vite's stylesheet has loaded.
    if (background)
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
  }
  function update() {
    document.documentElement.dataset.theme = getTheme();
    syncThemeColor();
    for (const listener of listeners) listener();
  }
  window.kitelineAppearance = {
    getPreference: () => preference,
    getTheme,
    setPreference(value) {
      preference = value;
      try {
        if (value === "system") localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (error) {
        console.warn("Could not save appearance preference; applied to this page only.", error);
      }
      update();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncThemeColor,
  };
  system.addEventListener("change", () => {
    if (preference === "system") update();
  });
  update();
})();
