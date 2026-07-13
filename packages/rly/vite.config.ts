import react from "@vitejs/plugin-react"
import { basename } from "node:path"
import { defineConfig, type Plugin } from "vite"
import { moduleEntrySources } from "./generated/vite-entries.js"

const entries = Object.fromEntries(
  Object.entries(moduleEntrySources).map(([id, source]) => [
    id === "root" ? "index" : `${id}/index`,
    new URL(`./${source}`, import.meta.url).pathname
  ])
)

const entrySourceMaps = (): Plugin => ({
  name: "rly-entry-source-maps",
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== "chunk") continue
      const mapFileName = `${output.fileName}.map`
      if (bundle[mapFileName] !== undefined) continue
      this.emitFile({
        type: "asset",
        fileName: mapFileName,
        source: JSON.stringify({
          version: 3,
          file: basename(output.fileName),
          sources: [],
          sourcesContent: [],
          names: [],
          mappings: ""
        })
      })
      output.code = `${output.code}\n//# sourceMappingURL=${basename(mapFileName)}\n`
    }
  }
})

export default defineConfig({
  plugins: [react(), entrySourceMaps()],
  build: {
    emptyOutDir: true,
    lib: {
      entry: entries,
      formats: ["es"]
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"]
    },
    sourcemap: true
  }
})
