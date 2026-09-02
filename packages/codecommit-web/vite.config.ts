import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import {
  authenticatedDevBackendOrigin,
  makeAuthenticatedDevProxyConfig
} from "./src/tooling/authenticated-dev-proxy.js"
import { productionPrototypeBoundary } from "./src/tooling/production-prototype-boundary.js"

const clientRoot = path.resolve(import.meta.dirname, "src/client")

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "")
  const backendOrigin = env.PORT === undefined
    ? authenticatedDevBackendOrigin
    : `http://127.0.0.1:${env.PORT}`

  return {
    plugins: [react(), tailwindcss(), productionPrototypeBoundary(clientRoot)],
    root: "src/client",
    build: {
      // The authenticated application shell includes the review workspace and syntax tooling.
      chunkSizeWarningLimit: 1100,
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
      proxy: makeAuthenticatedDevProxyConfig(backendOrigin)
    }
  }
})
