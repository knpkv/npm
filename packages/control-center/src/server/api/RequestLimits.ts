import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as RateLimiter from "effect/unstable/persistence/RateLimiter"

export const RequestLimitProfile = Schema.Literals([
  "pairing",
  "read",
  "mutation",
  "synchronization",
  "agent",
  "media"
])
export type RequestLimitProfile = typeof RequestLimitProfile.Type

/** Stable policy values applied by the API boundary. */
export interface RequestLimitPolicyValue {
  readonly maximumBodyBytes: number
  readonly pairing: { readonly limit: number; readonly window: Duration.Duration }
  readonly read: { readonly limit: number; readonly window: Duration.Duration }
  readonly mutation: { readonly limit: number; readonly window: Duration.Duration }
  readonly synchronization: { readonly limit: number; readonly window: Duration.Duration }
  readonly agent: { readonly limit: number; readonly window: Duration.Duration }
  readonly media: { readonly limit: number; readonly window: Duration.Duration }
  readonly readTimeout: Duration.Duration
  readonly mutationTimeout: Duration.Duration
  readonly synchronizationTimeout: Duration.Duration
  readonly agentTimeout: Duration.Duration
}

/** API request limits, replaceable in deterministic tests. */
export class RequestLimitPolicy extends Context.Service<
  RequestLimitPolicy,
  RequestLimitPolicyValue
>()("@knpkv/control-center/server/api/RequestLimitPolicy") {
  static readonly defaultLayer = Layer.succeed(RequestLimitPolicy, {
    maximumBodyBytes: 256 * 1024,
    pairing: { limit: 10, window: Duration.minutes(5) },
    read: { limit: 120, window: Duration.minutes(1) },
    mutation: { limit: 30, window: Duration.minutes(1) },
    synchronization: { limit: 8, window: Duration.minutes(1) },
    agent: { limit: 8, window: Duration.minutes(1) },
    media: { limit: 60, window: Duration.minutes(1) },
    readTimeout: Duration.seconds(15),
    mutationTimeout: Duration.seconds(30),
    synchronizationTimeout: Duration.minutes(10),
    agentTimeout: Duration.seconds(130)
  })
}

/** A request exceeded its bounded execution time. */
export class RequestTimeLimitExceeded extends Schema.TaggedErrorClass<RequestTimeLimitExceeded>()(
  "RequestTimeLimitExceeded",
  {}
) {}

/** A request exhausted its profile-specific token bucket. */
export class RequestRateLimitExceeded extends Schema.TaggedErrorClass<RequestRateLimitExceeded>()(
  "RequestRateLimitExceeded",
  {
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  }
) {}

/** The configured rate-limit store could not evaluate a request. */
export class RequestRateLimitUnavailable extends Schema.TaggedErrorClass<RequestRateLimitUnavailable>()(
  "RequestRateLimitUnavailable",
  {}
) {}

/** A declared request body is larger than the API permits. */
export class RequestBodyLimitExceeded extends Schema.TaggedErrorClass<RequestBodyLimitExceeded>()(
  "RequestBodyLimitExceeded",
  {
    maximumBytes: Schema.Int.check(Schema.isGreaterThan(0))
  }
) {}

const positiveCeilingSeconds = (duration: Duration.Duration): number =>
  Math.max(1, Math.ceil(Duration.toMillis(duration) / 1_000))

const profilePolicy = (
  policy: RequestLimitPolicyValue,
  profile: RequestLimitProfile
): { readonly limit: number; readonly window: Duration.Duration } => policy[profile]

/** Consume one request token without exposing the backing-store key in failures. */
export const consumeRequestToken = Effect.fn("RequestLimits.consumeToken")(function*(
  profile: RequestLimitProfile,
  key: string
) {
  const limiter = yield* RateLimiter.RateLimiter
  const policy = yield* RequestLimitPolicy
  const selected = profilePolicy(policy, profile)
  const result = yield* limiter.consume({
    algorithm: "token-bucket",
    key: `${profile}:${key}`,
    limit: selected.limit,
    onExceeded: "fail",
    window: selected.window
  }).pipe(
    Effect.mapError((failure) =>
      failure.reason._tag === "RateLimitExceeded"
        ? new RequestRateLimitExceeded({
          limit: failure.reason.limit,
          retryAfterSeconds: positiveCeilingSeconds(failure.reason.retryAfter)
        })
        : new RequestRateLimitUnavailable()
    )
  )
  return result
})

/** Reject a declared oversized body and bound chunked/body decoding downstream. */
export const enforceRequestBodyLimit = Effect.fn("RequestLimits.enforceBody")(function*() {
  const policy = yield* RequestLimitPolicy
  const request = yield* HttpServerRequest.HttpServerRequest
  const contentLength = request.headers["content-length"]
  if (contentLength !== undefined) {
    const bytes = Number(contentLength)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > policy.maximumBodyBytes) {
      return yield* new RequestBodyLimitExceeded({ maximumBytes: policy.maximumBodyBytes })
    }
  }
})

/** Apply the correct total execution budget for a request profile. */
export const withRequestTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  profile: RequestLimitProfile
): Effect.Effect<A, E | RequestTimeLimitExceeded, R | RequestLimitPolicy> =>
  Effect.flatMap(RequestLimitPolicy, (policy) =>
    Effect.timeoutOrElse(effect, {
      duration: profile === "agent"
        ? policy.agentTimeout
        : profile === "synchronization"
        ? policy.synchronizationTimeout
        : profile === "mutation" || profile === "pairing"
        ? policy.mutationTimeout
        : policy.readTimeout,
      orElse: () => Effect.fail(new RequestTimeLimitExceeded())
    }))

/** Body-size reference read by Node and multipart request decoders. */
export const withMaximumBodySize = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | RequestLimitPolicy> =>
  Effect.flatMap(RequestLimitPolicy, (policy) =>
    Effect.provideService(
      effect,
      HttpServerRequest.MaxBodySize,
      FileSystem.Size(policy.maximumBodyBytes)
    ))

/** Process-local limiter suitable for the single-process local Control Center. */
export const requestRateLimiterLayer = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory)
)
