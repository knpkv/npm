import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { rlyFontPreload } from "../../vite-font-preload.ts"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "")
  const backendOrigin = `http://127.0.0.1:${env.PORT ?? "3112"}`

  return {
    plugins: [react(), rlyFontPreload()],
    root: "src/client",
    build: { outDir: "../../dist/client", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      // The dev server is the public origin; the API and the bootstrap exchange are proxied to the
      // bound server, so the session cookie applies. Anchored so `api.ts` itself is not proxied.
      proxy: {
        "^/api/": { target: backendOrigin, changeOrigin: false, ws: true },
        "^/auth/": { target: backendOrigin, changeOrigin: false }
      }
    }
  }
})
