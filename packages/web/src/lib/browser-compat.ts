// Imported first in main.tsx so every later module sees this Chromium 97 polyfill.
import clone from "@ungap/structured-clone";

if (!globalThis.structuredClone) globalThis.structuredClone = (value) => clone(value);
