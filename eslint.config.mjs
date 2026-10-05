import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: [
      "web/src/**/*.{ts,tsx}",
      "shared/src/protocol/{index,rpc,tasks,text}.ts",
      "shared/src/terminal/index.ts",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["toSorted", "toReversed", "toSpliced", "throwIfAborted"].map((property) => ({
          property,
          message: "Not available in the supported Chromium 97 runtime.",
        })),
        ...[
          ["Promise", "withResolvers"],
          ["AbortSignal", "timeout"],
          ["AbortSignal", "any"],
          ["Intl", "supportedValuesOf"],
        ].map(([object, property]) => ({
          object,
          property,
          message: "Not available in the supported Chromium 97 runtime.",
        })),
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@kiteline/shared/protocol/stdio",
                "@kiteline/shared/protocol/ws",
                "@kiteline/shared/protocol/file-stream",
                "@kiteline/shared/protocol/http-stream",
                "@kiteline/shared/terminal/node",
                "@kiteline/shared/terminal/windows",
                "@kiteline/shared/windows/*",
              ],
              message: "The browser cannot use Node-only shared entry points.",
            },
          ],
        },
      ],
    },
  },
);
