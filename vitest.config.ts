import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{server,agent,terminal-recorder,web}/test/**/*.test.ts"],
  },
});
