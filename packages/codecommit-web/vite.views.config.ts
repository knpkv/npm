import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"
import { BROWSER_TARGET } from "../../browser-target.ts"

const viewsEntry = path.resolve(import.meta.dirname, "src/views.ts")

/** Include library styles without leaving a CSS side-effect import in emitted declarations. */
const viewsStyles: Plugin = {
  name: "views-styles",
  enforce: "pre",
  transform(source, id) {
    if (id !== viewsEntry) return
    return { code: `import "./views.css"\n${source}`, map: null }
  }
}

export default defineConfig({
  plugins: [viewsStyles, react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/client")
    }
  },
  build: {
    target: BROWSER_TARGET,
    outDir: "dist/views",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: viewsEntry,
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style"
    },
    rollupOptions: {
      external: (id: string) =>
        /^(?:react(?:\/|$)|react-dom(?:\/|$)|react-router(?:\/|$)|effect(?:\/|$)|@effect\/|@knpkv\/)/.test(id)
    }
  }
})
