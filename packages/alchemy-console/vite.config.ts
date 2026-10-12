import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { BROWSER_TARGET } from "../../browser-target.ts"
import { rlyFontPreload } from "../../vite-font-preload.ts"

export default defineConfig({
  plugins: [react(), rlyFontPreload()],
  root: "src/client",
  build: {
    target: BROWSER_TARGET,
    outDir: "../../dist/client",
    emptyOutDir: true,
    assetsInlineLimit: 0
  }
})
