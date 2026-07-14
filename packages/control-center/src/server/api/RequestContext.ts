import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

import { CorrelationId } from "../../api/errors.js"
import type { CorrelationId as CorrelationIdType } from "../../api/errors.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"

/** Request-scoped, secret-free metadata safe for structured logs. */
export interface CurrentRequestContextValue {
  readonly correlationId: CorrelationIdType
  readonly method: string
  readonly remoteAddress: string | null
  readonly startedAt: UtcTimestamp
  readonly url: string
}

/** Request-scoped metadata shared by API middleware and handlers. */
export class CurrentRequestContext extends Context.Service<
  CurrentRequestContext,
  CurrentRequestContextValue
>()("@knpkv/control-center/server/api/CurrentRequestContext") {}

/** Correlation ID generation failed before a request context could be established. */
export class RequestContextUnavailable extends Schema.TaggedErrorClass<RequestContextUnavailable>()(
  "RequestContextUnavailable",
  {}
) {}

const decodeSuppliedCorrelationId = (input: string | undefined): CorrelationIdType | undefined => {
  const decoded = Schema.decodeUnknownResult(CorrelationId)(input)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** Build validated metadata for the current HTTP request. */
export const makeCurrentRequestContext = Effect.fn("RequestContext.make")(function*() {
  const cryptoService = yield* Crypto.Crypto
  const request = yield* HttpServerRequest.HttpServerRequest
  const supplied = decodeSuppliedCorrelationId(request.headers["x-correlation-id"])
  const correlationId = supplied ?? (yield* cryptoService.randomUUIDv7.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CorrelationId)),
    Effect.mapError(() => new RequestContextUnavailable())
  ))

  return {
    correlationId,
    method: request.method,
    remoteAddress: Option.getOrNull(request.remoteAddress),
    startedAt: yield* DateTime.now,
    url: request.url
  } satisfies CurrentRequestContextValue
})

/** Attach the current correlation ID to successes and failures before sending. */
export const withCorrelationResponse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  correlationId: CorrelationIdType
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  HttpEffect.withPreResponseHandler(
    effect,
    (_request, response) => Effect.succeed(HttpServerResponse.setHeader(response, "x-correlation-id", correlationId))
  )

/** Provide request metadata to an inner API operation and annotate its logs. */
export const provideCurrentRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: CurrentRequestContextValue
): Effect.Effect<A, E, Exclude<R, CurrentRequestContext>> =>
  effect.pipe(
    Effect.provideService(CurrentRequestContext, context),
    Effect.annotateLogs({
      correlationId: context.correlationId,
      httpMethod: context.method,
      httpUrl: context.url
    })
  )
