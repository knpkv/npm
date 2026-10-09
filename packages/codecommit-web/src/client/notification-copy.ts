/**
 * Words for a system notification about a failed AWS call: what failed, the provider's cause, and the
 * one thing that fixes it. The server records `{ operation, profile, region, cause }`; this module turns
 * that into a sentence a reader can act on, instead of "getPullRequests — AwsApiError".
 *
 * @module
 */

/** A failed operation as the server records it; every field may be absent in older rows. */
export interface FailedOperation {
  readonly operation?: string | undefined
  readonly profile?: string | undefined
  readonly region?: string | undefined
  readonly cause?: string | undefined
}

/** Operations the server reports, in the reader's words; others read "<operation> failed". */
const operationWords = new Map([
  ["getCallerIdentity", "Couldn't confirm who you are"],
  ["getPullRequests", "Couldn't list pull requests"]
])

const signInAgain = /expired|ExpiredToken|UnrecognizedClient|InvalidClientTokenId|Credentials unavailable|SSO|token/i
const throttled = /^Throttled:|Rate exceeded|Throttl/i
const denied = /AccessDenied|not authorized|UnauthorizedOperation/i
const notAllowed = /^Not allowed( yet)?:/

/** The one action that fixes a cause, or `null` when the cause names nothing actionable. */
export const fixFor = (cause: string): string | null => {
  if (notAllowed.test(cause)) return "Allow it in Settings → Permissions."
  if (throttled.test(cause)) return "It's retried on the next refresh."
  if (denied.test(cause)) return "Check that this profile's role can read CodeCommit."
  if (signInAgain.test(cause)) return "Sign in again in Settings → Accounts."
  return null
}

/** "Couldn't list pull requests in dev (eu-central-1): <cause>. Sign in again in Settings → Accounts." */
export const failedOperationText = (failure: FailedOperation): string => {
  const what = failure.operation === undefined
    ? "Something failed"
    : (operationWords.get(failure.operation) ?? `${failure.operation} failed`)
  const where = failure.profile === undefined
    ? ""
    : ` in ${failure.profile}${failure.region === undefined ? "" : ` (${failure.region})`}`
  const cause = failure.cause?.trim() ?? ""
  const fix = cause.length === 0 ? null : fixFor(cause)
  const sentence = cause.length === 0 ? `${what}${where}.` : `${what}${where}: ${cause.replace(/\.$/, "")}.`
  return fix === null ? sentence : `${sentence} ${fix}`
}
