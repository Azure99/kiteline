import clone from "@ungap/structured-clone";

if (!globalThis.structuredClone) globalThis.structuredClone = (value) => clone(value);
