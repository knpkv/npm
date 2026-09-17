import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/client")
    }
  },
  test: {
    environment: "node",
    exclude: ["test/relay-explain-real-smoke.test.ts"],
    globals: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"]
  }
})
