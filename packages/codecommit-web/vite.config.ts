import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "path"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      "@": path.resolve(__dirname, "src/client"),
      "@knpkv/codecommit-core": path.resolve(__dirname, "../codecommit-core/src")
    }
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  }
})
