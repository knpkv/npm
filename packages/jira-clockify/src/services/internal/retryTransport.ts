/** Retrying idempotent provider reads across dropped connections. */
import * as Effect from "effect/Effect"
import * as HttpClientError from "effect/http/HttpClientError"
import * as Schedule from "effect/Schedule"

/**
 * Retry an idempotent read whose connection dropped. A response the server chose — any status, any
 * body — is final: only a transport failure is retried, twice, so one network blip cannot discard a
 * read that took minutes of attribution to reach. Never wrap a write: a dropped POST may have landed.
 */
export const retryTransport = <A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  read.pipe(Effect.retry({
    schedule: Schedule.exponential("250 millis"),
    times: 2,
    while: (error) => HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError"
  }))
