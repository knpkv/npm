import { defineConfig } from "vite"
import { BROWSER_TARGET } from "../../browser-target.ts"

export default defineConfig({
  build: {
    target: BROWSER_TARGET,
    outDir: "dist/client", emptyOutDir: true,
    lib: { entry: "src/client/bootstrap.ts", formats: ["es"], fileName: () => "bootstrap.js" }
  }
})
