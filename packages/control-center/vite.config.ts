import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { controlCenterBuildGraph } from "./scripts/build-graph.js"

const packageRoot = new URL(".", import.meta.url).pathname

export default defineConfig(({ mode }) => {
  const isServer = mode === "server"
  return {
    build: isServer
      ? {
        emptyOutDir: true,
        outDir: "dist/server",
        rollupOptions: {
          input: {
            "api/index": "src/api/index.ts",
            "domain/index": "src/domain/index.ts",
            index: "src/index.ts",
            "server/cli": "src/server/cli.ts",
            "server/index": "src/server/index.ts"
          },
          output: {
            entryFileNames: "[name].js"
          }
        },
        sourcemap: true,
        ssr: true
      }
      : {
        emptyOutDir: true,
        manifest: true,
        outDir: "dist/client",
        sourcemap: true
      },
    plugins: [react(), controlCenterBuildGraph(packageRoot, isServer ? "server" : "client")],
    ...(isServer ? { ssr: { external: true } } : {})
  }
})
