import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"

import {
  AwsSignInRequiredApiError,
  ConflictApiError,
  CorrelationId,
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  PayloadTooLargeApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "../../api/errors.js"
import type {
  AuthCryptoError,
  AuthPermissionDeniedError,
  AuthPersistenceError,
  CredentialRejectedError
} from "../auth/errors.js"
import type { RequestSecurityError } from "../security/RequestSecurity.js"
import type {
  ApplicationAwsSignInRequired,
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationRateLimited,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable
} from "./ApplicationServices.js"
import { CurrentRequestContext } from "./RequestContext.js"
import type {
  RequestRateLimitExceeded,
  RequestRateLimitUnavailable,
  RequestTimeLimitExceeded
} from "./RequestLimits.js"

const withCorrelation = <A>(make: (correlationId: typeof CorrelationId.Type) => A): Effect.Effect<A> =>
  Effect.contextWith((context: Context.Context<never>) => {
    const current = Context.getOption(context, CurrentRequestContext)
    return Effect.succeed(make(Option.match(current, {
      onNone: () => CorrelationId.make("unavailable"),
      onSome: ({ correlationId }) => correlationId
    })))
  })

export const unauthorizedApiError = withCorrelation((correlationId) =>
  new UnauthorizedApiError({
    code: "unauthorized",
    correlationId,
    message: "A valid active session is required."
  })
)

export const forbiddenApiError = withCorrelation((correlationId) =>
  new ForbiddenApiError({
    code: "forbidden",
    correlationId,
    message: "This session cannot perform the requested operation."
  })
)

export const invalidRequestApiError = withCorrelation((correlationId) =>
  new InvalidRequestApiError({
    code: "invalid-request",
    correlationId,
    message: "The request failed validation."
  })
)

/** Public capacity response for an authenticated live stream rejected before subscription. */
export const liveStreamCapacityApiError = withCorrelation((correlationId) =>
  new RateLimitedApiError({
    code: "rate-limited",
    correlationId,
    message: "Too many live update streams are already open.",
    retryAt: null
  })
)

export const serviceUnavailableApiError = (
  retryAt: ApplicationServiceUnavailable["retryAt"] = null
) =>
  withCorrelation((correlationId) =>
    new ServiceUnavailableApiError({
      code: "service-unavailable",
      correlationId,
      message: "A required local service is temporarily unavailable.",
      retryAt
    })
  )

export const notFoundApiError = withCorrelation((correlationId) =>
  new NotFoundApiError({
    code: "not-found",
    correlationId,
    message: "The requested resource was not found."
  })
)

export const payloadTooLargeApiError = (maximumBytes: number) =>
  withCorrelation((correlationId) =>
    new PayloadTooLargeApiError({
      code: "payload-too-large",
      correlationId,
      message: `The request body exceeds the ${maximumBytes} byte limit.`
    })
  )

export const mapAuthenticationFailures = <A, R>(
  effect: Effect.Effect<
    A,
    AuthCryptoError | AuthPermissionDeniedError | AuthPersistenceError | CredentialRejectedError,
    R
  >
) =>
  effect.pipe(
    Effect.catchTags({
      AuthCryptoError: () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail),
      AuthPermissionDeniedError: () => Effect.flatMap(forbiddenApiError, Effect.fail),
      AuthPersistenceError: () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail),
      CredentialRejectedError: () => Effect.flatMap(unauthorizedApiError, Effect.fail)
    })
  )

export const mapCredentialAuthenticationFailures = <A, R>(
  effect: Effect.Effect<
    A,
    AuthCryptoError | AuthPersistenceError | CredentialRejectedError,
    R
  >
) =>
  effect.pipe(
    Effect.catchTags({
      AuthCryptoError: () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail),
      AuthPersistenceError: () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail),
      CredentialRejectedError: () => Effect.flatMap(unauthorizedApiError, Effect.fail)
    })
  )

/** Map centralized transport-policy failures without exposing allow-list details. */
export const mapPairingSecurityFailure = (_error: RequestSecurityError) =>
  Effect.flatMap(invalidRequestApiError, Effect.fail)

export const mapReadSecurityFailure = (_error: RequestSecurityError) => Effect.flatMap(forbiddenApiError, Effect.fail)

export const mapMutationSecurityFailure = (
  error: RequestSecurityError
): Effect.Effect<never, ForbiddenApiError | InvalidRequestApiError> =>
  error.reason === "csrf-required" || error.reason === "method-mismatch"
    ? Effect.flatMap(invalidRequestApiError, Effect.fail)
    : Effect.flatMap(forbiddenApiError, Effect.fail)

export const mapApplicationUnavailable = (error: ApplicationServiceUnavailable) =>
  Effect.flatMap(serviceUnavailableApiError(error.retryAt), Effect.fail)

export const mapApplicationNotFound = (_error: ApplicationResourceNotFound) =>
  Effect.flatMap(notFoundApiError, Effect.fail)

export const mapApplicationRateLimited = (error: ApplicationRateLimited) =>
  Effect.flatMap(
    withCorrelation((correlationId) =>
      new RateLimitedApiError({
        code: "rate-limited",
        correlationId,
        message: "The provider request budget is exhausted.",
        retryAt: error.retryAt
      })
    ),
    Effect.fail
  )

export const mapApplicationConflict = (_error: ApplicationConflict) =>
  Effect.flatMap(
    withCorrelation((correlationId) =>
      new ConflictApiError({
        code: "conflict",
        correlationId,
        message: "The resource changed since it was read. Refresh and retry."
      })
    ),
    Effect.fail
  )

export const mapApplicationInvalidRequest = (_error: ApplicationInvalidRequest) =>
  Effect.flatMap(invalidRequestApiError, Effect.fail)

/** The profile is not sent back: the browser already holds it, and the error stays secret-free. */
export const mapApplicationAwsSignInRequired = (_error: ApplicationAwsSignInRequired) =>
  Effect.flatMap(
    withCorrelation((correlationId) =>
      new AwsSignInRequiredApiError({
        code: "aws-sign-in-required",
        correlationId,
        message: "The AWS profile needs a fresh sign-in."
      })
    ),
    Effect.fail
  )

/** Mutable assembly of the optional budget field; the emitted error stays immutable. */
interface RequestBudgetFields {
  budget?: NonNullable<RateLimitedApiError["budget"]>
}

export const mapRequestRateLimitFailure = Effect.fn("ErrorMapping.requestRateLimit")(function*(
  error: RequestRateLimitExceeded
) {
  const now = yield* DateTime.now
  const budget: RequestBudgetFields = {}
  if (error.budget !== undefined) budget.budget = error.budget
  const failure = yield* withCorrelation((correlationId) =>
    new RateLimitedApiError({
      code: "rate-limited",
      correlationId,
      message: error.budget === undefined
        ? "The request budget is exhausted."
        : `The ${error.budget} synchronization request budget is exhausted.`,
      retryAt: DateTime.add(now, { seconds: error.retryAfterSeconds }),
      retryAfterSeconds: error.retryAfterSeconds,
      ...budget
    })
  )
  return yield* HttpEffect.withPreResponseHandler(
    Effect.fail(failure),
    (_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "retry-after", String(error.retryAfterSeconds))
      )
  )
})

export const mapRequestRateLimitUnavailable = (_error: RequestRateLimitUnavailable) =>
  Effect.flatMap(serviceUnavailableApiError(), Effect.fail)

export const mapRequestTimeLimitFailure = (_error: RequestTimeLimitExceeded) =>
  Effect.flatMap(
    withCorrelation((correlationId) =>
      new RequestTimedOutApiError({
        code: "request-timed-out",
        correlationId,
        message: "The request exceeded its server deadline."
      })
    ),
    Effect.fail
  )
