// Fixtures from packages/codecommit-web/test/settings-relay.test.ts and packages/codecommit-web/test/settings-sandbox.test.ts.
import type { ReviewConfig } from "@knpkv/codecommit-core/ConfigService.js"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as AsyncResult from "effect/reactivity/AsyncResult"

// The settings tests use defaultReviewConfig, expanded here without importing its runtime.
const review: ReviewConfig = {
  defaultProfileId: "thorough",
  profiles: [
    { id: "thorough", name: "Thorough review", kind: "review", provider: "codex", harness: "native-codex", model: "configured-default", skillIds: ["builtin:pr-review", "builtin:pr-review-diff"] },
    { id: "security", name: "Security review", kind: "security", provider: "codex", harness: "native-codex", model: "configured-default", skillIds: ["builtin:pr-review-diff"] },
    { id: "tests", name: "Test review", kind: "tests", provider: "codex", harness: "native-codex", model: "configured-default", skillIds: ["builtin:pr-review-diff"] },
    { id: "explain", name: "Explain change", kind: "explain", provider: "codex", harness: "native-codex", model: "configured-default", skillIds: [] }
  ]
}
export const config = { accounts: [], autoDetect: false, autoRefresh: true, refreshIntervalSeconds: 300, review }
export const sandboxConfig = {
  ...config,
  sandbox: {
    image: "codercom/code-server@sha256:b88ed46a6ace76a0294a17a24f39aa88032ed0a3692c3d8ab5433b47ab57ccbf",
    extensions: [], setupCommands: [], env: {}, volumeMounts: [], cloneDepth: 0
  }
}
export const readyConfig = AsyncResult.success(config)
export const readySandboxConfig = AsyncResult.success(sandboxConfig)
export const loadingConfig = AsyncResult.initial(true)
export const failedConfig = AsyncResult.failure(Cause.die("Config unavailable"))
export const emptySkills = AsyncResult.success([])
export const environmentSkills = AsyncResult.success([
  { id: "env:test:extra", name: "Extra review", description: "Typed failure fixture", source: "environment" }
])
export const saveRelay = () => Promise.resolve(Exit.succeed<"saved">("saved"))
export const saveSandbox = () => Promise.resolve("saved")
export const noop = () => {}
