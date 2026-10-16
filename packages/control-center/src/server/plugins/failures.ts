import * as Schema from "effect/Schema"

import { PluginActionReconciliationKey } from "../../domain/plugins/actions.js"
import { PluginCapabilityId } from "../../domain/plugins/descriptor.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

const SafeOperation = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
)
const SafeDiagnosticCode = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
)

/** Provider credentials are missing, expired, or rejected. */
export class PluginAuthenticationFailure extends Schema.TaggedError<PluginAuthenticationFailure>()(
  "PluginAuthenticationFailure",
  { operation: SafeOperation }
) {}

/** Provider credentials are valid but lack the requested permission. */
export class PluginAuthorizationFailure extends Schema.TaggedError<PluginAuthorizationFailure>()(
  "PluginAuthorizationFailure",
  { operation: SafeOperation }
) {}

/** Provider rate limit with a decoded absolute retry time. */
export class PluginRateLimitFailure extends Schema.TaggedError<PluginRateLimitFailure>()(
  "PluginRateLimitFailure",
  { operation: SafeOperation, retryAt: UtcTimestamp }
) {}

/** Bounded provider operation exceeded its configured timeout. */
export class PluginTimeoutFailure extends Schema.TaggedError<PluginTimeoutFailure>()(
  "PluginTimeoutFailure",
  { operation: SafeOperation }
) {}

/** Untrusted provider output did not satisfy the versioned contract. */
export class PluginMalformedResponseFailure extends Schema.TaggedError<PluginMalformedResponseFailure>()(
  "PluginMalformedResponseFailure",
  { operation: SafeOperation, diagnosticCode: SafeDiagnosticCode }
) {}

/** Provider was unavailable independently of credentials and rate limits. */
export class PluginOutageFailure extends Schema.TaggedError<PluginOutageFailure>()(
  "PluginOutageFailure",
  { operation: SafeOperation }
) {}

/** Scoped plugin operation was interrupted by cancellation. */
export class PluginCancellationFailure extends Schema.TaggedError<PluginCancellationFailure>()(
  "PluginCancellationFailure",
  { operation: SafeOperation }
) {}

/** Provider state or idempotency identity conflicts with the requested action. */
export class PluginConflictFailure extends Schema.TaggedError<PluginConflictFailure>()(
  "PluginConflictFailure",
  { operation: SafeOperation, diagnosticCode: SafeDiagnosticCode }
) {}

/** Required contract capability or version is unavailable. */
export class PluginUnsupportedCapabilityFailure extends Schema.TaggedError<PluginUnsupportedCapabilityFailure>()(
  "PluginUnsupportedCapabilityFailure",
  {
    capabilityId: Schema.NullOr(PluginCapabilityId),
    requestedVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    diagnosticCode: SafeDiagnosticCode
  }
) {}

/** Secret-free plugin configuration cannot construct a valid connection. */
export class PluginConfigurationFailure extends Schema.TaggedError<PluginConfigurationFailure>()(
  "PluginConfigurationFailure",
  { diagnosticCode: SafeDiagnosticCode }
) {}

/** Provider mutation may have occurred and must be reconciled, never retried blindly. */
export class PluginUnknownOutcomeFailure extends Schema.TaggedError<PluginUnknownOutcomeFailure>()(
  "PluginUnknownOutcomeFailure",
  { operation: SafeOperation, reconciliationKey: PluginActionReconciliationKey }
) {}

/** Closed typed failure taxonomy shared by every plugin adapter. */
export type PluginFailure =
  | PluginAuthenticationFailure
  | PluginAuthorizationFailure
  | PluginRateLimitFailure
  | PluginTimeoutFailure
  | PluginMalformedResponseFailure
  | PluginOutageFailure
  | PluginCancellationFailure
  | PluginConflictFailure
  | PluginUnsupportedCapabilityFailure
  | PluginConfigurationFailure
  | PluginUnknownOutcomeFailure

/** Stable health classification for a typed plugin failure. */
export const pluginFailureClass = (
  failure: PluginFailure
):
  | "authentication"
  | "authorization"
  | "rate-limit"
  | "timeout"
  | "malformed-response"
  | "outage"
  | "configuration"
  | "unknown" =>
{
  switch (failure._tag) {
    case "PluginAuthenticationFailure":
      return "authentication"
    case "PluginAuthorizationFailure":
      return "authorization"
    case "PluginRateLimitFailure":
      return "rate-limit"
    case "PluginTimeoutFailure":
      return "timeout"
    case "PluginMalformedResponseFailure":
      return "malformed-response"
    case "PluginOutageFailure":
      return "outage"
    case "PluginCancellationFailure":
    case "PluginConflictFailure":
    case "PluginUnsupportedCapabilityFailure":
    case "PluginUnknownOutcomeFailure":
      return "unknown"
    case "PluginConfigurationFailure":
      return "configuration"
  }
}

/**
 * What to fix for a configuration failure, safe to show: it names the missing resource kind, never a
 * provider locator. Syncing again can't fix these, so the sentence points at the connection instead.
 */
export const pluginFailureSafeMessage = (failure: PluginConfigurationFailure): string =>
  failure.diagnosticCode === "codecommit-provider-object-not-found"
    ? "The repository wasn’t found in this account and region. Check the repository name or region, then edit the connection."
    : "This connection’s settings don’t match the provider. Check them, then edit the connection."
