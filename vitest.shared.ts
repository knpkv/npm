import type { ViteUserConfig } from "vitest/config"

const config: ViteUserConfig = {
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@knpkv/clockify-api-client": new URL("./packages/clockify-api-client/src/index.ts", import.meta.url).pathname,
      "@knpkv/jira-api-client": new URL("./packages/jira-api-client/src/index.ts", import.meta.url).pathname
    }
  },
  esbuild: {
    target: "es2020"
  },
  optimizeDeps: {
    exclude: ["bun:sqlite"]
  },
  test: {
    setupFiles: [new URL("./vitest.setup.ts", import.meta.url).pathname],
    fakeTimers: {
      toFake: undefined
    },
    sequence: {
      concurrent: true
    },
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["html"],
      reportsDirectory: "coverage",
      exclude: [
        "node_modules/",
        "dist/",
        "benchmark/",
        "bundle/",
        "dtslint/",
        "build/",
        "coverage/",
        "test/utils/",
        "**/*.d.ts",
        "**/*.config.*",
        "**/vitest.setup.*",
        "**/vitest.shared.*"
      ],
      all: true
    }
  }
}

export default config
