export default ({ mode }: { mode: string }) => {
  if (mode !== "chrome") throw new Error("Build with --mode chrome");
  return {
    publicDir: "public/chrome",
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
