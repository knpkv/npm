import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { BROWSER_TARGET } from "../../browser-target.ts"

export default defineConfig({
  base: "./",
  plugins: [react()],
  css: {
    modules: {
      generateScopedName: "rly_[name]__[local]"
    }
  },
  build: {
    target: BROWSER_TARGET,
    cssCodeSplit: true,
    emptyOutDir: false,
    lib: {
      entry: {
        "diff/bounded/index": new URL("./src/diff/bounded/index.ts", import.meta.url).pathname
      },
      formats: ["es"]
    },
    rollupOptions: {
      external: ["lucide-react", "radix-ui", "react", "react-dom", "react/jsx-runtime"],
      output: {
        assetFileNames: "diff/bounded/[name][extname]"
      }
    },
    sourcemap: true
  }
})
