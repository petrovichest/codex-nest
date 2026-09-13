import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export default ({ mode }: { mode: string }) => {
  if (mode !== "chrome") throw new Error("Build with --mode chrome");
  return {
    publicDir: "public/chrome",
    plugins: [
      {
        name: "onest-license",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "assets/LICENSE-Onest-OFL.txt",
            source: readFileSync(
              new URL("../client/src/assets/fonts/LICENSE-Onest-OFL.txt", import.meta.url),
              "utf8",
            ),
          });
        },
      } satisfies Plugin,
    ],
    build: {
      emptyOutDir: true,
      outDir: "dist/chrome",
      rollupOptions: {
        input: {
          popup: "popup.html",
          panel: "panel.html",
          background: "src/background.ts",
          content: "src/content.ts",
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
      sourcemap: true,
      target: "chrome116",
    },
  };
};
