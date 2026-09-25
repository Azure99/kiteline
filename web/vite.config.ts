import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const serverProxy = { target: "http://127.0.0.1:8080", ws: true };
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": serverProxy,
      "/proxy": serverProxy,
      "/absproxy": serverProxy,
      "/healthz": serverProxy,
      "/connect.sh": serverProxy,
      "/install.sh": serverProxy,
      "/downloads": serverProxy,
    },
  },
});
