import { createRequire } from "node:module";

export const xtermAlias = [
  {
    find: /^@xterm\/xterm$/,
    replacement: createRequire(import.meta.url).resolve(
      "@xterm/xterm/src/browser/public/Terminal.ts",
    ),
  },
];

// xterm sources use legacy parameter decorators.
export const xtermTransform = { decorator: { legacy: true } };
