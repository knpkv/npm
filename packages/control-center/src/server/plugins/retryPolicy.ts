import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"

import type { PluginFailure } from "./failures.js"

/** Provider operation classes whose retry safety is decided by the caller. */
export type PluginOperationSafety = "safe-read" | "idempotent-write" | "unsafe-mutation"

/** Input for one bounded plugin operation. The effect remains lazy across attempts. */
export interface RetryPluginOperationOptions<Value, Requirements> {
  readonly operation: Effect.Effect<Value, PluginFailure, Requirements>
  readonly safety: PluginOperationSafety
}

/** Input for one bounded plugin stream. The stream remains lazy across attempts. */
export interface RetryPluginStreamOptions<Value, Requirements> {
  readonly stream: Stream.Stream<Value, PluginFailure, Requirements>
  readonly safety: PluginOperationSafety
}

/** Maximum total attempts, including the initial provider call. */
export const PLUGIN_OPERATION_MAX_ATTEMPTS = 3

/** Initial upper bound for full-jitter transient retry delay. */
export const PLUGIN_RETRY_BASE_DELAY_MILLIS = 100

/** Hard upper bound for every full-jitter transient retry delay. */
export const PLUGIN_RETRY_MAX_DELAY_MILLIS = 10_000

/**
 * Hard upper bound for honoring an explicit provider Retry-After instant.
 *
 * Higher than {@link PLUGIN_RETRY_MAX_DELAY_MILLIS} because a rate-limit failure
 * carries a provider-supplied instant we should respect (e.g. CodeCommit surfaces
 * a ~30s window after exhausting its own throttle backoff). Waits beyond this
 * ceiling still fail fast rather than retaining a fiber.
 */
export const PLUGIN_RATE_LIMIT_MAX_DELAY_MILLIS = 60_000

const permitsRetry = (safety: PluginOperationSafety): boolean => safety !== "unsafe-mutation"

/** Whether one typed provider failure may be retried for the declared operation safety. */
export const isPluginFailureRetryable = (safety: PluginOperationSafety, failure: PluginFailure): boolean => {
  if (!permitsRetry(safety)) return false
  switch (failure._tag) {
    case "PluginRateLimitFailure":
    case "PluginTimeoutFailure":
    case "PluginOutageFailure":
      return true
    case "PluginAuthenticationFailure":
    case "PluginAuthorizationFailure":
    case "PluginMalformedResponseFailure":
    case "PluginCancellationFailure":
    case "PluginConflictFailure":
    case "PluginUnsupportedCapabilityFailure":
    case "PluginConfigurationFailure":
    case "PluginUnknownOutcomeFailure":
      return false
  }
}

const retryDelay = (failure: PluginFailure, failedAttempt: number): Effect.Effect<void, PluginFailure> => {
  if (failure._tag !== "PluginRateLimitFailure") {
    const maximumDelay = Math.min(
      PLUGIN_RETRY_MAX_DELAY_MILLIS,
      PLUGIN_RETRY_BASE_DELAY_MILLIS * 2 ** (failedAttempt - 1)
    )
    return Random.nextIntBetween(0, maximumDelay).pipe(Effect.flatMap(Effect.sleep))
  }
  return Effect.flatMap(Clock.currentTimeMillis, (currentTimeMillis) => {
    const delay = Math.max(0, DateTime.toEpochMillis(failure.retryAt) - currentTimeMillis)
    return delay <= PLUGIN_RATE_LIMIT_MAX_DELAY_MILLIS ? Effect.sleep(delay) : Effect.fail(failure)
  })
}

const runAttempt = <Value, Requirements>(
  options: RetryPluginOperationOptions<Value, Requirements>,
  attempt: number
): Effect.Effect<Value, PluginFailure, Requirements> =>
  Effect.catch(options.operation, (failure) => {
    if (attempt >= PLUGIN_OPERATION_MAX_ATTEMPTS || !isPluginFailureRetryable(options.safety, failure)) {
      return Effect.fail(failure)
    }
    return retryDelay(failure, attempt).pipe(Effect.andThen(runAttempt(options, attempt + 1)))
  })

/** Run a plugin operation with bounded, failure-aware retries and Retry-After support. */
export const retryPluginOperation = <Value, Requirements>(
  options: RetryPluginOperationOptions<Value, Requirements>
): Effect.Effect<Value, PluginFailure, Requirements> => runAttempt(options, 1)

const runStreamAttempt = <Value, Requirements>(
  options: RetryPluginStreamOptions<Value, Requirements>,
  attempt: number,
  emitted: Ref.Ref<boolean>
): Stream.Stream<Value, PluginFailure, Requirements> =>
  options.stream.pipe(
    Stream.tap(() => Ref.set(emitted, true)),
    Stream.catch((failure) =>
      Stream.unwrap(
        Ref.get(emitted).pipe(
          Effect.map((hasEmitted) => {
            if (
              hasEmitted ||
              attempt >= PLUGIN_OPERATION_MAX_ATTEMPTS ||
              !isPluginFailureRetryable(options.safety, failure)
            ) {
              return Stream.fail(failure)
            }
            return Stream.unwrap(
              retryDelay(failure, attempt).pipe(Effect.map(() => runStreamAttempt(options, attempt + 1, emitted)))
            )
          })
        )
      )
    )
  )

/** Retry a plugin stream at most three total times when its operation is safe. */
export const retryPluginStream = <Value, Requirements>(
  options: RetryPluginStreamOptions<Value, Requirements>
): Stream.Stream<Value, PluginFailure, Requirements> =>
  Stream.unwrap(Ref.make(false).pipe(Effect.map((emitted) => runStreamAttempt(options, 1, emitted))))
