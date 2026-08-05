import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspaceProtocolSource = fileURLToPath(
  new URL("../../packages/protocol/src/index.ts", import.meta.url),
);
const managedParentProtocolSource = fileURLToPath(
  new URL("../../../../../packages/protocol/src/index.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  ...(process.env.NODE_ENV === "test"
    ? {
        resolve: {
          alias: {
            "@codexnest/protocol": existsSync(managedParentProtocolSource)
              ? managedParentProtocolSource
              : workspaceProtocolSource,
          },
        },
      }
    : {}),
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Managed test worktrees live below .git; Vite's default deny list would
    // otherwise hide every test module from the Vitest worker.
    ...(process.env.NODE_ENV === "test" ? { fs: { deny: [] } } : {}),
    proxy: {
      "/api": { target: "http://127.0.0.1:4310", ws: true },
    },
  },
  build: { sourcemap: true },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
