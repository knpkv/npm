import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@knpkv/atlassian-common/attachments": new URL("../atlassian-common/src/attachments.ts", import.meta.url).pathname,
      "@knpkv/atlassian-common/auth": new URL("../atlassian-common/src/auth/index.ts", import.meta.url).pathname,
      "@knpkv/atlassian-common/config": new URL("../atlassian-common/src/config/index.ts", import.meta.url).pathname,
      "@knpkv/agent-skills": new URL("../agent-skills/src/index.ts", import.meta.url).pathname,
      "@knpkv/confluence-api-client": new URL("../confluence-api-client/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["test/integration.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    teardownTimeout: 60000
  }
})
