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
export * as PRService from "./PRService/index.js"

// Re-export Effect dependencies for convenience
export { Registry } from "@effect-atom/atom"
export { Reactivity } from "@effect/experimental"
