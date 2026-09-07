import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "")
  const backendOrigin = `http://127.0.0.1:${env.PORT ?? "3111"}`

  return {
    plugins: [react()],
    root: "src/client",
    build: { outDir: "../../dist/client", emptyOutDir: true },
    resolve: {
      alias: { "@knpkv/jira-clockify": path.resolve(import.meta.dirname, "../jira-clockify/src") }
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      // The dev server is the public origin; every API call and the bootstrap exchange are proxied
      // to the bound server, so the browser stays on one origin and the session cookie applies.
      proxy: {
        "/api": { target: backendOrigin, changeOrigin: false },
        "/auth": { target: backendOrigin, changeOrigin: false }
      }
    }
  }
})
