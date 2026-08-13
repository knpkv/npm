import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"
import { productionPrototypeBoundary } from "./src/tooling/production-prototype-boundary.js"
import { authenticatedDevProxyConfig } from "./src/tooling/authenticated-dev-proxy.js"

const clientRoot = path.resolve(import.meta.dirname, "src/client")

export default defineConfig({
  plugins: [react(), tailwindcss(), productionPrototypeBoundary(clientRoot)],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      external: [
        "@aws-sdk/credential-providers",
        "@smithy/shared-ini-file-loader",
        "distilled-aws",
        "distilled-aws/codecommit",
        "distilled-aws/sts"
      ]
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/client"),
      "@knpkv/codecommit-core": path.resolve(import.meta.dirname, "../codecommit-core/src")
    }
  },
  server: {
    proxy: authenticatedDevProxyConfig
  }
})
