import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

const nodeOnlyShared = [
  "node/*",
  "windows/*",
  "protocol/stdio",
  "protocol/ws",
  "protocol/file-stream",
  "protocol/http-stream",
  "terminal/node",
  "terminal/windows",
  "terminal/pane",
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}", "packages/shared/src/**/*.ts"],
    ignores: nodeOnlyShared.map((path) => `packages/shared/src/${path}.ts`),
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
    files: ["packages/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: nodeOnlyShared.map((path) => `@kiteline/shared/${path}`),
              message: "The browser cannot use Node-only shared entry points.",
            },
          ],
        },
      ],
    },
  },
);
