import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { editorResetCompat } from "./build/editor-reset-compat.js";

const serverProxy = { target: "http://127.0.0.1:8080", ws: true };
export default defineConfig({
  plugins: [react(), tailwindcss({ optimize: { minify: false } })],
  css: { postcss: { plugins: [editorResetCompat()] } },
  build: { target: "chrome97", cssTarget: "chrome97", cssCodeSplit: false },
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
