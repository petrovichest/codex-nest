import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4310", ws: true },
    },
  },
  build: { sourcemap: true },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
