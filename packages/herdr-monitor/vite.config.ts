import { defineConfig } from "vite"

export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    assetsInlineLimit: 100000,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: "board.js", assetFileNames: "board.[ext]" } }
  }
})
