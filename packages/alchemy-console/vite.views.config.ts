import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"
import { BROWSER_TARGET } from "../../browser-target.ts"

const viewsEntry = path.resolve(import.meta.dirname, "src/views.ts")
// CSS is a browser-build concern; declaration imports stay usable by non-Vite consumers.
const viewsStyles: Plugin = {
  name: "alchemy-views-styles",
  transform(source, id) {
    if (id === viewsEntry) return { code: `import "./views.css"\n${source}`, map: null }
  }
}

export default defineConfig({
  plugins: [viewsStyles, react()],
  css: {
    postcss: {
      plugins: [{
        postcssPlugin: "alchemy-external-fonts",
        Declaration(declaration) {
          // Vite library mode otherwise inlines fonts despite assetsInlineLimit. Keep CSP self-only.
          if (declaration.prop === "src") declaration.value = declaration.value.replace(/url\("([^"?]+\.woff2)"\)/g, 'url("$1?no-inline")')
        }
      }]
    }
  },
  build: {
    target: BROWSER_TARGET,
    outDir: "dist/views",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: viewsEntry, formats: ["es"], fileName: () => "index.js", cssFileName: "style" },
    rollupOptions: {
      external: (id: string) => /^(?:react(?:\/|$)|react-dom(?:\/|$)|effect(?:\/|$)|@effect\/|@knpkv\/)/.test(id)
    }
  }
})
