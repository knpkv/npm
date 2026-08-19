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
  /**
   * HTTP status, present only when the provider actually answered.
   *
   * Absent means the request never produced a response — transport failure,
   * timeout, interruption — which is *not* evidence about the credential.
   * Callers deciding whether to discard stored tokens must key off this and
   * {@link errorCode} rather than off {@link step}, since a refresh that merely
   * failed to complete may well have been consumed server-side.
   */
  readonly status?: number
  /**
   * The OAuth 2.0 `error` code from the response body (RFC 6749 §5.2), when the
   * provider sent a parseable one.
   *
   * Status alone is too coarse to act on: `400` covers `invalid_grant` (the
   * stored token really is spent) as well as `invalid_client`,
   * `invalid_request` and `unsupported_grant_type`, which say the *request* was
   * wrong and imply nothing about the token. Absent when the body was missing
   * or unparseable, in which case callers should assume the credential is still
   * good rather than discard it on a guess.
   */
  readonly errorCode?: string
}> {
  override get message(): string {
    if (Predicate.isString(this.cause)) {
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
