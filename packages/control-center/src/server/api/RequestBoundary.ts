import { isIP } from "node:net"

import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Types from "effect/Types"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import * as RateLimiter from "effect/unstable/persistence/RateLimiter"
import type {
  InvalidRequestApiError,
  PayloadTooLargeApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
} from "../../api/errors.js"
import { DEFAULT_HTTP_SECURITY_LIMITS } from "../http/security/HttpLimits.js"
import { authorizeRequestBody, type RequestBodyPolicyError } from "../http/security/RequestPolicy.js"
import { securityHeaders } from "../http/security/SecurityHeaders.js"
import { ApiBindConfiguration } from "./ApiConfiguration.js"
import {
  invalidRequestApiError,
  mapRequestRateLimitFailure,
  mapRequestRateLimitUnavailable,
  mapRequestTimeLimitFailure,
  payloadTooLargeApiError,
  serviceUnavailableApiError
} from "./ErrorMapping.js"
import { makeCurrentRequestContext, provideCurrentRequest, withCorrelationResponse } from "./RequestContext.js"
import {
  consumeRequestToken,
  RequestLimitPolicy,
  type RequestLimitProfile,
  withMaximumBodySize,
  withRequestTimeout
} from "./RequestLimits.js"

type BoundaryApiError =
  | InvalidRequestApiError
  | PayloadTooLargeApiError
  | RateLimitedApiError
  | RequestTimedOutApiError
  | ServiceUnavailableApiError

const profileFor = (request: HttpServerRequest.HttpServerRequest): RequestLimitProfile => {
  if (request.url.startsWith("/api/v1/session/pair")) return "pairing"
  if (request.url.startsWith("/api/v1/agent/")) return "agent"
  if (request.url.startsWith("/api/v1/media/")) return "media"
  if (
    request.method === "POST" &&
    /^\/api\/v1\/plugins\/[^/?]+\/sync(?:\?|$)/u.test(request.url)
  ) return "synchronization"
  if (
    request.method === "POST" &&
    /^\/api\/v1\/diffs\/[^/?]+\/pull-requests\/[^/?]+\/content(?:\?|$)/u.test(request.url)
  ) return "read"
  return request.method === "GET" || request.method === "HEAD" ? "read" : "mutation"
}

const requestBodyMetadata = (request: HttpServerRequest.HttpServerRequest) => ({
  method: request.method,
  contentEncoding: request.headers["content-encoding"] ?? null,
  contentLength: request.headers["content-length"] ?? null,
  contentType: request.headers["content-type"] ?? null,
  transferEncoding: request.headers["transfer-encoding"] ?? null
})

const isJsonPayload = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === "POST" || request.method === "PUT" || request.method === "PATCH"

const hasNoStoreDirective = (value: string | undefined): boolean =>
  value?.split(",").some((directive) => directive.trim().toLowerCase() === "no-store") ?? false

const canonicalIpAddress = (input: string): string | undefined => {
  if (input.length === 0 || input.length > 64 || input.trim() !== input || isIP(input) === 0) return undefined
  if (!input.includes(":")) return input
  const hostname = new URL(`http://[${input}]/`).hostname
  return hostname.slice(1, -1)
}

/**
 * Select the rate-limit identity at the last trusted hop. The forwarding header
 * must contain exactly one IP because a configured proxy is required to
 * overwrite, rather than append to, `X-Forwarded-For`.
 */
export const clientRateLimitKey = (
  trustedProxyAddresses: ReadonlyArray<string>,
  immediatePeer: string | null,
  forwardedFor: string | undefined
): string => {
  const peer = immediatePeer === null ? undefined : canonicalIpAddress(immediatePeer)
  const trustedPeer = peer !== undefined && trustedProxyAddresses.some((address) => address === peer)
  if (trustedPeer && forwardedFor !== undefined) {
    const forwardedClient = canonicalIpAddress(forwardedFor)
    if (forwardedClient !== undefined) return `client:${forwardedClient}`
  }
  return `peer:${peer ?? "unknown"}`
}

const requestKey = (config: ApiBindConfiguration["Service"], request: HttpServerRequest.HttpServerRequest): string =>
  clientRateLimitKey(
    config.trustedProxyAddresses,
    Option.getOrNull(request.remoteAddress),
    request.headers["x-forwarded-for"]
  )

const hasBoundedRequestMetadata = (request: HttpServerRequest.HttpServerRequest): boolean => {
  if (request.url.length > DEFAULT_HTTP_SECURITY_LIMITS.maximumRequestUrlBytes) return false
  const headers = Object.entries(request.headers)
  if (headers.length > DEFAULT_HTTP_SECURITY_LIMITS.maximumHeaderCount) return false
  let bytes = 0
  for (const [name, value] of headers) {
    bytes += name.length + (value?.length ?? 0) + 4
    if (bytes > DEFAULT_HTTP_SECURITY_LIMITS.maximumHeaderBytes) return false
  }
  return true
}

const statusFor = (error: BoundaryApiError): number => {
  switch (error._tag) {
    case "InvalidRequestApiError":
      return 400
    case "RequestTimedOutApiError":
      return 408
    case "PayloadTooLargeApiError":
      return 413
    case "RateLimitedApiError":
      return 429
    case "ServiceUnavailableApiError":
      return 503
  }
}

const apiErrorResponse = (error: BoundaryApiError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(error, {
    status: statusFor(error),
    headers: { "cache-control": "no-store" }
  })

const mapBodyPolicyFailure = (
  error: RequestBodyPolicyError
): Effect.Effect<never, InvalidRequestApiError | PayloadTooLargeApiError> =>
  error.reason === "body-too-large"
    ? Effect.flatMap(payloadTooLargeApiError(error.maximumBytes ?? 0), Effect.fail)
    : Effect.flatMap(invalidRequestApiError, Effect.fail)

const transformSchemaDefect = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | InvalidRequestApiError | ServiceUnavailableApiError, R> =>
  Effect.catchCause(effect, (cause): Effect.Effect<never, E | InvalidRequestApiError | ServiceUnavailableApiError> => {
    const defect = Cause.findDefect(cause)
    if (Result.isFailure(defect) || !HttpApiError.HttpApiSchemaError.is(defect.success)) {
      return Effect.failCause(cause)
    }
    if (defect.success.kind !== "Body") {
      return Effect.flatMap(invalidRequestApiError, Effect.fail)
    }
    return Effect.logError("HTTP API response schema validation failed").pipe(
      Effect.andThen(Effect.flatMap(serviceUnavailableApiError(), Effect.fail))
    )
  })

/**
 * Global boundary: correlation and browser headers everywhere, plus body policy,
 * rate budgets, bounded execution, and typed failures only under `/api`.
 */
export const requestBoundaryLayer = HttpRouter.middleware(
  Effect.gen(function*() {
    const bindConfig = yield* ApiBindConfiguration
    const cryptoService = yield* Crypto.Crypto
    const limiter = yield* RateLimiter.RateLimiter
    const policy = yield* RequestLimitPolicy

    return (routeEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
      Effect.gen(function*() {
        const context = yield* makeCurrentRequestContext()
        const request = yield* HttpServerRequest.HttpServerRequest
        const isApiRequest = request.url === "/api" || request.url.startsWith("/api/")

        const apiGuarded = Effect.gen(function*() {
          const profile = profileFor(request)
          yield* authorizeRequestBody({
            expectsJson: isJsonPayload(request),
            maximumBytes: policy.maximumBodyBytes,
            metadata: requestBodyMetadata(request)
          }).pipe(Effect.catchTag("RequestBodyPolicyError", mapBodyPolicyFailure))
          yield* consumeRequestToken(profile, requestKey(bindConfig, request)).pipe(
            Effect.catchTags({
              RequestRateLimitExceeded: mapRequestRateLimitFailure,
              RequestRateLimitUnavailable: mapRequestRateLimitUnavailable
            })
          )
          return yield* withRequestTimeout(
            withMaximumBodySize(transformSchemaDefect(routeEffect)),
            profile
          ).pipe(
            Effect.catchTag("RequestTimeLimitExceeded", mapRequestTimeLimitFailure)
          )
        }).pipe(
          Effect.catchTags({
            InvalidRequestApiError: (error) => Effect.succeed(apiErrorResponse(error)),
            PayloadTooLargeApiError: (error) => Effect.succeed(apiErrorResponse(error)),
            RateLimitedApiError: (error) => Effect.succeed(apiErrorResponse(error)),
            RequestTimedOutApiError: (error) => Effect.succeed(apiErrorResponse(error)),
            ServiceUnavailableApiError: (error) => Effect.succeed(apiErrorResponse(error))
          })
        )

        const guarded = !hasBoundedRequestMetadata(request)
          ? Effect.flatMap(invalidRequestApiError, (error) => Effect.succeed(apiErrorResponse(error)))
          : isApiRequest
          ? apiGuarded
          : routeEffect

        const withOuterHeaders = HttpEffect.withPreResponseHandler(
          provideCurrentRequest(guarded, context),
          (_request, response) =>
            Effect.succeed(HttpServerResponse.setHeaders(
              response,
              {
                ...securityHeaders({ isSecureTransport: bindConfig.cookieSecure }),
                ...(isApiRequest && !hasNoStoreDirective(response.headers["cache-control"])
                  ? { "cache-control": "no-store" }
                  : {})
              }
            ))
        )
        return yield* withCorrelationResponse(withOuterHeaders, context.correlationId)
      }).pipe(
        Effect.provideService(ApiBindConfiguration, bindConfig),
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.provideService(RateLimiter.RateLimiter, limiter),
        Effect.provideService(RequestLimitPolicy, policy)
      )
  }),
  { global: true }
)
