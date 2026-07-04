/**
 * Tagged error types for Atlassian OAuth2 flows.
 *
 * **Mental model**
 *
 * - **Step-scoped errors**: {@link OAuthError} carries a `step` field (`"configure" | "authorize" |
 *   "token" | "refresh" | "revoke"`) so callers can handle failures per-phase.
 * - **Companion errors**: {@link AuthMissingError} (not logged in) and
 *   {@link OAuthNotConfiguredError} (no client credentials) represent pre-flow failures.
 *
 * **Gotchas**
 *
 * - `OAuthError.message` is a computed getter derived from `step` + `cause` — it's not
 *   a stored field, so don't destructure it from the constructor.
 *
 * @module
 */
import * as Data from "effect/Data"
import * as Predicate from "effect/Predicate"

/**
 * OAuth flow step for error context.
 *
 * @category Types
 */
export type OAuthStep = "configure" | "authorize" | "token" | "resources" | "user-info" | "refresh" | "revoke"

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
  override get message(): string {
    if (typeof this.cause === "string") {
      return `OAuth ${this.step} failed: ${this.cause}`
    }
    if (Predicate.hasProperty(this.cause, "message")) {
      return `OAuth ${this.step} failed: ${String(this.cause.message)}`
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
  override get message(): string {
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
  override get message(): string {
    const toolPart = this.tool ? `'${this.tool} auth configure'` : "'auth configure'"
    return `OAuth not configured. Run ${toolPart} first.`
  }
}
