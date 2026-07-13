import react from "@vitejs/plugin-react"
import { basename } from "node:path"
import { defineConfig, type Plugin } from "vite"
import { componentManifest } from "./component-manifest.js"
import { moduleEntrySources } from "./generated/vite-entries.js"
import { componentStyleSources } from "./scripts/contract.js"

const entries = Object.fromEntries(
  Object.entries(moduleEntrySources).map(([id, source]) => [
    id === "root" ? "index" : `${id}/index`,
    new URL(`./${source}`, import.meta.url).pathname
  ])
)

const componentStyles = (): Plugin => {
  const rootEntry = new URL(`./${moduleEntrySources.root}`, import.meta.url).pathname
  const imports = componentStyleSources(componentManifest)
    .map((source) => `import ${JSON.stringify(`./${source.slice("src/".length)}`)}`)
    .join("\n")

  return {
    name: "rly-component-styles",
    enforce: "pre",
    transform(source, id) {
      if (id !== rootEntry || imports.length === 0) return
      return { code: `${source}\n${imports}\n`, map: null }
    }
  }
}

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
  plugins: [componentStyles(), react(), entrySourceMaps()],
  css: {
    modules: {
      generateScopedName: "rly_[name]__[local]"
    }
  },
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    lib: {
      cssFileName: "components",
      entry: entries,
      formats: ["es"]
    },
    rollupOptions: {
      external: ["lucide-react", "radix-ui", "react", "react-dom", "react/jsx-runtime"]
    },
    sourcemap: true
  }
})
