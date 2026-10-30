import { createRequire } from "node:module";

export const xtermAlias = [
  {
    find: /^@xterm\/xterm$/,
    replacement: createRequire(import.meta.url).resolve(
      "@xterm/xterm/src/browser/public/Terminal.ts",
    ),
  },
];

// xterm uses legacy parameter decorators in builds, dev prebundling, and tests.
export const xtermTransform = { decorator: { legacy: true } };
