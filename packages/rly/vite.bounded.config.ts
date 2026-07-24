import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  plugins: [react()],
  css: {
    modules: {
      generateScopedName: "rly_[name]__[local]"
    }
  },
  build: {
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
