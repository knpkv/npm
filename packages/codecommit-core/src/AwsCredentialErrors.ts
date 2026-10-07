/**
 * Classify AWS provider errors that mean the credentials themselves no longer work.
 *
 * Shared by every AWS adapter so CodeCommit refresh, CodeCommit plugin reads and CodePipeline reads agree
 * on what an expired or rejected session looks like. It is deliberately narrower than the provider's own
 * auth category, which also covers missing grants (`AccessDenied`, `NotAuthorized`) and service opt-in
 * (`OptInRequired`): there the credentials work and the identity still holds.
 *
 * @example
 * ```typescript
 * import { isCredentialInvalidCause } from "@knpkv/codecommit-core/AwsCredentialErrors.js"
 *
 * if (isCredentialInvalidCause(error.cause)) {
 *   // ask the user to sign in again
 * }
 * ```
 *
 * @module
 */
import { Predicate } from "effect"

/** Provider error tags that mean the credentials are invalid, expired or unsigned. */
export const credentialInvalidTags: ReadonlySet<string> = new Set([
  "ExpiredTokenException",
  "ExpiredToken",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "SignatureDoesNotMatch",
  "AuthFailure"
])

const tagOf = <Value>(value: Value, key: "_tag" | "errorTag"): string =>
  Predicate.hasProperty(value, key) && Predicate.isString(value[key]) ? value[key] : ""

/**
 * Whether a provider error says the credentials are invalid: its tag, or, for an error the provider
 * client doesn't know (`UnknownAwsError`), its wire tag.
 */
export const isCredentialInvalidCause = <Cause>(cause: Cause): boolean =>
  credentialInvalidTags.has(tagOf(cause, "_tag")) ||
  (tagOf(cause, "_tag") === "UnknownAwsError" && credentialInvalidTags.has(tagOf(cause, "errorTag")))
