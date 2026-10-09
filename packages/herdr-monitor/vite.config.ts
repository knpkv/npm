import { defineConfig } from "vite"
import { BROWSER_TARGET } from "../../browser-target.ts"

export default defineConfig({
  root: "src/client",
  build: {
    target: BROWSER_TARGET,
    outDir: "../../dist/web",
    emptyOutDir: true,
    assetsInlineLimit: 100000,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: "board.js", assetFileNames: "board.[ext]" } }
  }
})
