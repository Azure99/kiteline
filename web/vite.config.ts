import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { editorResetCompat } from "./postcss/editor-reset-compat.js";

const serverProxy = { target: "http://127.0.0.1:8080", ws: true };
// xterm uses legacy parameter decorators in both builds and dev prebundling.
const xtermTransform = { decorator: { legacy: true } };
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@xterm\/xterm$/,
        replacement: fileURLToPath(
          new URL(
            "src/browser/public/Terminal.ts",
            import.meta.resolve("@xterm/xterm/package.json"),
          ),
        ),
      },
    ],
  },
  oxc: xtermTransform,
  optimizeDeps: { rolldownOptions: { transform: xtermTransform } },
  plugins: [
    react(),
    // Keep reset layers for editorResetCompat; Vite minifies the result.
    tailwindcss({ optimize: { minify: false } }),
    {
      name: "static-resource-licenses",
      generateBundle() {
        for (const [name, source] of [
          ["project.txt", new URL("../LICENSE", import.meta.url)],
          [
            "tailwindcss.txt",
            new URL("./LICENSE", import.meta.resolve("tailwindcss/package.json")),
          ],
          ["vite.txt", new URL("./LICENSE.md", import.meta.resolve("vite/package.json"))],
        ] as const)
          this.emitFile({
            type: "asset",
            fileName: `licenses/${name}`,
            source: readFileSync(source, "utf8"),
          });
        const xtermCss = readFileSync(
          new URL(import.meta.resolve("@xterm/xterm/css/xterm.css")),
          "utf8",
        );
        const xtermLicense = xtermCss.match(/^\/\*[\s\S]*?\*\//)?.[0];
        if (!xtermLicense) throw new Error("xterm CSS license header is missing");
        this.emitFile({
          type: "asset",
          fileName: "licenses/xterm-css.txt",
          source: xtermLicense + "\n",
        });
      },
    },
  ],
  css: { postcss: { plugins: [editorResetCompat()] } },
  build: {
    target: "chrome97",
    cssTarget: "chrome97",
    // The Chrome 97 cascade-layers transform needs the complete stylesheet.
    cssCodeSplit: false,
    license: { fileName: "licenses/dependencies.md" },
  },
  server: {
    proxy: {
      "/api": serverProxy,
      "/proxy": serverProxy,
      "/absproxy": serverProxy,
      "/healthz": serverProxy,
      "/connect.sh": serverProxy,
      "/install.sh": serverProxy,
      "/upgrade.sh": serverProxy,
      "/connect.ps1": serverProxy,
      "/install.ps1": serverProxy,
      "/upgrade.ps1": serverProxy,
      "/downloads": serverProxy,
    },
  },
});
