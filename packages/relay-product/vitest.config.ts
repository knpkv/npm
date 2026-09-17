import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@knpkv/rly/foundations": fileURLToPath(new URL("../rly/src/foundations/index.ts", import.meta.url)),
      "@knpkv/rly/patterns": fileURLToPath(new URL("../rly/src/patterns/index.ts", import.meta.url)),
      "@knpkv/rly/primitives": fileURLToPath(new URL("../rly/src/primitives/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "happy-dom",
    name: "@knpkv/relay-product",
    include: ["test/**/*.test.{ts,tsx}"]
  }
})
