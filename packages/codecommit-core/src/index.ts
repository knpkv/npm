/**
 * `@knpkv/codecommit-core` — Core logic for CodeCommit PR browser.
 *
 * Namespace re-exports for clean imports.
 *
 * @example
 * ```typescript
 * import { Domain, Errors, AwsClient } from "@knpkv/codecommit-core"
 *
 * const id: Domain.PullRequestId = ...
 * const error = new Errors.AwsApiError({ ... })
 * ```
 *
 * @module
 */
export * as AwsClient from "./AwsClient/index.js"
export * as AwsClientConfig from "./AwsClientConfig.js"
export * as CacheService from "./CacheService/index.js"
export * as ConfigService from "./ConfigService/index.js"
export * as DateUtils from "./DateUtils.js"
export * as Domain from "./Domain.js"
export * as Errors from "./Errors.js"
export * as PermissionService from "./PermissionService/index.js"
export * as PRService from "./PRService/index.js"
export * as ReadClient from "./ReadClient/index.js"
export * as ReviewClient from "./ReviewClient/index.js"
export * as SandboxService from "./SandboxService/index.js"
export * as StatsService from "./StatsService/index.js"

// Re-export Effect dependencies for convenience
export { AtomRegistry as Registry, Reactivity } from "effect/unstable/reactivity"
