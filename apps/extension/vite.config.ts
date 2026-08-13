export default ({ mode }: { mode: string }) => {
  if (mode !== "chrome" && mode !== "firefox") {
    throw new Error("Build with --mode chrome or --mode firefox");
  }
  return {
    publicDir: `public/${mode}`,
    define: {
      __CODEXNEST_BROWSER_TARGET__: JSON.stringify(mode),
    },
    build: {
      emptyOutDir: true,
      outDir: `dist/${mode}`,
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
      target: mode === "chrome" ? "chrome116" : "firefox146",
    },
  };
};
