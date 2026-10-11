import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"
import { BROWSER_TARGET } from "../../browser-target.ts"

const viewsEntry = fileURLToPath(new URL("src/views.ts", import.meta.url))

/** Collect view module styles without a CSS import in the public declaration. */
const viewsStyles: Plugin = {
  name: "views-styles",
  enforce: "pre",
  transform(source, id) {
    if (id !== viewsEntry) return
    return { code: `import "./views.css"\n${source}`, map: null }
  }
}

/** Build the public browser views independently of the application and server outputs. */
export default defineConfig({
  plugins: [viewsStyles, react()],
  publicDir: false,
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
