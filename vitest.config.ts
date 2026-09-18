import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{server,agent,terminal-recorder,shared,web}/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
