/**
 * OAuth2 error types.
 *
 * @module
 */
import * as Data from "effect/Data"

/**
 * OAuth flow step for error context.
 *
 * @category Types
 */
export type OAuthStep = "configure" | "authorize" | "token" | "refresh" | "revoke"

/**
 * Error during OAuth2 flow.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { OAuthError } from "@knpkv/atlassian-common/auth"
 *
 * Effect.gen(function* () {
 *   // ... oauth operation
 * }).pipe(
 *   Effect.catchTag("OAuthError", (error) =>
 *     Effect.sync(() => console.error(`OAuth error at ${error.step}: ${error.message}`))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class OAuthError extends Data.TaggedError("OAuthError")<{
  readonly step: OAuthStep
  readonly cause?: unknown
}> {
  get message(): string {
    if (this.cause instanceof Error) {
      return `OAuth ${this.step} failed: ${this.cause.message}`
    }
    if (typeof this.cause === "string") {
      return `OAuth ${this.step} failed: ${this.cause}`
    }
    return `OAuth ${this.step} failed`
  }
}

/**
 * Error when authentication is missing.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { AuthMissingError } from "@knpkv/atlassian-common/auth"
 *
 * Effect.gen(function* () {
 *   // ... requires auth
 * }).pipe(
 *   Effect.catchTag("AuthMissingError", () =>
 *     Effect.sync(() => console.error("Please login first"))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class AuthMissingError extends Data.TaggedError("AuthMissingError")<{
  readonly tool?: string
}> {
  get message(): string {
    const toolPart = this.tool ? ` for ${this.tool}` : ""
    return `Not logged in${toolPart}. Please run 'auth login' first.`
  }
}

/**
 * Error when OAuth is not configured.
 *
 * @category Errors
 */
export class OAuthNotConfiguredError extends Data.TaggedError("OAuthNotConfiguredError")<{
  readonly tool?: string
}> {
  get message(): string {
    const toolPart = this.tool ? `'${this.tool} ` : ""
    return `OAuth not configured. Run ${toolPart}auth configure' first.`
  }
}
