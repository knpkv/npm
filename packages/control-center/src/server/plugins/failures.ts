import * as Schema from "effect/Schema"

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
const SafeOpaqueKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)

/** Provider credentials are missing, expired, or rejected. */
export class PluginAuthenticationFailure extends Schema.TaggedErrorClass<PluginAuthenticationFailure>()(
  "PluginAuthenticationFailure",
  { operation: SafeOperation }
) {}

/** Provider credentials are valid but lack the requested permission. */
export class PluginAuthorizationFailure extends Schema.TaggedErrorClass<PluginAuthorizationFailure>()(
  "PluginAuthorizationFailure",
  { operation: SafeOperation }
) {}

/** Provider rate limit with a decoded absolute retry time. */
export class PluginRateLimitFailure extends Schema.TaggedErrorClass<PluginRateLimitFailure>()(
  "PluginRateLimitFailure",
  { operation: SafeOperation, retryAt: UtcTimestamp }
) {}

/** Bounded provider operation exceeded its configured timeout. */
export class PluginTimeoutFailure extends Schema.TaggedErrorClass<PluginTimeoutFailure>()(
  "PluginTimeoutFailure",
  { operation: SafeOperation }
) {}

/** Untrusted provider output did not satisfy the versioned contract. */
export class PluginMalformedResponseFailure extends Schema.TaggedErrorClass<PluginMalformedResponseFailure>()(
  "PluginMalformedResponseFailure",
  { operation: SafeOperation, diagnosticCode: SafeDiagnosticCode }
) {}

/** Provider was unavailable independently of credentials and rate limits. */
export class PluginOutageFailure extends Schema.TaggedErrorClass<PluginOutageFailure>()(
  "PluginOutageFailure",
  { operation: SafeOperation }
) {}

/** Scoped plugin operation was interrupted by cancellation. */
export class PluginCancellationFailure extends Schema.TaggedErrorClass<PluginCancellationFailure>()(
  "PluginCancellationFailure",
  { operation: SafeOperation }
) {}

/** Provider state or idempotency identity conflicts with the requested action. */
export class PluginConflictFailure extends Schema.TaggedErrorClass<PluginConflictFailure>()(
  "PluginConflictFailure",
  { operation: SafeOperation, diagnosticCode: SafeDiagnosticCode }
) {}

/** Required contract capability or version is unavailable. */
export class PluginUnsupportedCapabilityFailure extends Schema.TaggedErrorClass<PluginUnsupportedCapabilityFailure>()(
  "PluginUnsupportedCapabilityFailure",
  {
    capabilityId: Schema.NullOr(PluginCapabilityId),
    requestedVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    diagnosticCode: SafeDiagnosticCode
  }
) {}

/** Secret-free plugin configuration cannot construct a valid connection. */
export class PluginConfigurationFailure extends Schema.TaggedErrorClass<PluginConfigurationFailure>()(
  "PluginConfigurationFailure",
  { diagnosticCode: SafeDiagnosticCode }
) {}

/** Provider mutation may have occurred and must be reconciled, never retried blindly. */
export class PluginUnknownOutcomeFailure extends Schema.TaggedErrorClass<PluginUnknownOutcomeFailure>()(
  "PluginUnknownOutcomeFailure",
  { operation: SafeOperation, reconciliationKey: SafeOpaqueKey }
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
): "authentication" | "authorization" | "rate-limit" | "timeout" | "malformed-response" | "outage" | "unknown" => {
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
    case "PluginConfigurationFailure":
    case "PluginUnknownOutcomeFailure":
      return "unknown"
  }
}
