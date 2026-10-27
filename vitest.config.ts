import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const webRequire = createRequire(new URL("./packages/web/package.json", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@xterm\/xterm$/,
        replacement: webRequire.resolve("@xterm/xterm/src/browser/public/Terminal.ts"),
      },
    ],
  },
  oxc: { decorator: { legacy: true } },
  test: {
    include: [
      "packages/{server,agent,terminal-recorder,web,cli}/test/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
  },
});
