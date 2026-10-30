import { defineConfig } from "vitest/config";
import { xtermAlias, xtermTransform } from "./packages/web/xterm-config.js";

export default defineConfig({
  resolve: { alias: xtermAlias },
  oxc: xtermTransform,
  test: {
    include: [
      "packages/{server,agent,terminal-recorder,web,cli}/test/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
  },
});
