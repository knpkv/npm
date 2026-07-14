import * as Schema from "effect/Schema"

import { UtcTimestamp } from "../domain/utcTimestamp.js"

const SAFE_API_MESSAGE_MAXIMUM_LENGTH = 500

const SafeApiMessage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(SAFE_API_MESSAGE_MAXIMUM_LENGTH)
)

/** Correlation identifier shared by one HTTP response header and its typed error body. */
export const CorrelationId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/u, { expected: "an HTTP-safe correlation identifier" })
).pipe(Schema.brand("CorrelationId"))

/** Decoded HTTP correlation identifier. */
export type CorrelationId = typeof CorrelationId.Type

const commonErrorFields = {
  correlationId: CorrelationId,
  message: SafeApiMessage
}

/** A request failed schema, authority, origin, or CSRF-shape validation. */
export class InvalidRequestApiError extends Schema.TaggedErrorClass<InvalidRequestApiError>()(
  "InvalidRequestApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("invalid-request")
  },
  { httpApiStatus: 400 }
) {}

/** The browser did not present a valid active session. */
export class UnauthorizedApiError extends Schema.TaggedErrorClass<UnauthorizedApiError>()(
  "UnauthorizedApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("unauthorized")
  },
  { httpApiStatus: 401 }
) {}

/** The active session cannot perform the requested capability. */
export class ForbiddenApiError extends Schema.TaggedErrorClass<ForbiddenApiError>()(
  "ForbiddenApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("forbidden")
  },
  { httpApiStatus: 403 }
) {}

/** An authenticated lookup did not resolve to a visible resource. */
export class NotFoundApiError extends Schema.TaggedErrorClass<NotFoundApiError>()(
  "NotFoundApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("not-found")
  },
  { httpApiStatus: 404 }
) {}

/** Current durable state conflicts with the requested transition. */
export class ConflictApiError extends Schema.TaggedErrorClass<ConflictApiError>()(
  "ConflictApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("conflict")
  },
  { httpApiStatus: 409 }
) {}

/** A bounded request exceeded the public API size limit. */
export class PayloadTooLargeApiError extends Schema.TaggedErrorClass<PayloadTooLargeApiError>()(
  "PayloadTooLargeApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("payload-too-large")
  },
  { httpApiStatus: 413 }
) {}

/** The request did not complete within its bounded server deadline. */
export class RequestTimedOutApiError extends Schema.TaggedErrorClass<RequestTimedOutApiError>()(
  "RequestTimedOutApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("request-timed-out")
  },
  { httpApiStatus: 408 }
) {}

/** The caller must wait until the optional safe retry instant. */
export class RateLimitedApiError extends Schema.TaggedErrorClass<RateLimitedApiError>()(
  "RateLimitedApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("rate-limited"),
    retryAt: Schema.NullOr(UtcTimestamp)
  },
  { httpApiStatus: 429 }
) {}

/** A required local or provider service is temporarily unavailable. */
export class ServiceUnavailableApiError extends Schema.TaggedErrorClass<ServiceUnavailableApiError>()(
  "ServiceUnavailableApiError",
  {
    ...commonErrorFields,
    code: Schema.Literal("service-unavailable"),
    retryAt: Schema.NullOr(UtcTimestamp)
  },
  { httpApiStatus: 503 }
) {}

/** Required response header attached to every successful and failed API response. */
export const CorrelationResponseHeaders = Schema.Struct({
  "x-correlation-id": CorrelationId
}).annotate({ identifier: "CorrelationResponseHeaders" })

/** Decoded correlation response headers. */
export type CorrelationResponseHeaders = typeof CorrelationResponseHeaders.Type
