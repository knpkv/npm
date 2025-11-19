/**
 * @internal
 * Stream utilities for async generator conversion.
 */

import { Effect, Option, Stream } from "effect"
import type * as AgentError from "../ClaudeAgentError.js"

/**
 * @internal
 * Convert async iterable to Effect Stream with error handling.
 */
export const asyncIterableToStream = <A, E>(
  iterable: AsyncIterable<A>,
  onError: (error: unknown) => E
): Stream.Stream<A, E> => Stream.fromAsyncIterable(iterable, onError)

/**
 * @internal
 * Wrap async generator in Effect for resource management.
 */
export const wrapAsyncGenerator = <A, E>(
  generator: AsyncIterator<A>,
  onError: (error: unknown) => E
): Stream.Stream<A, E> =>
  Stream.unfoldEffect(
    generator,
    (gen) =>
      Effect.gen(function*() {
        try {
          const result = yield* Effect.promise(() => gen.next())
          if (result.done) {
            return Option.none()
          }
          return Option.some([result.value, gen] as const)
        } catch (error) {
          return yield* Effect.fail(onError(error))
        }
      })
  )

/**
 * @internal
 * Collect stream to array.
 */
export const collectStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Effect.Effect<ReadonlyArray<A>, E, R> => Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)))

/**
 * @internal
 * Handle stream errors with recovery.
 */
export const handleStreamError = <A, E extends AgentError.StreamError, R>(
  stream: Stream.Stream<A, E, R>,
  recover: (error: E) => Stream.Stream<A, E, R>
): Stream.Stream<A, E, R> => stream.pipe(Stream.catchAll(recover))
