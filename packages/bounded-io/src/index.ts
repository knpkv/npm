/**
 * Byte-capped Effect streams.
 *
 * **Mental model**
 *
 * - A budget is a running total of `byteLength`. `limit` is inclusive: a stream of
 *   exactly `limit` bytes succeeds; the chunk that takes the total past it fails
 *   the stream with {@link ByteLimitExceeded}, and nothing after it is pulled.
 * - Failing is the only overflow behaviour; nothing is truncated.
 * - Upstream failures pass through unchanged, so a caller maps
 *   `ByteLimitExceeded` to its own error and leaves the rest alone.
 * - Interrupting or failing a collection inside the caller's scope is what stops a
 *   child process; this module never spawns or kills anything itself.
 *
 * @module
 */
import { Effect, Schema, Stream } from "effect"

/** A stream produced more than `limit` bytes; `observedBytes` is the total at the crossing chunk. */
export class ByteLimitExceeded extends Schema.TaggedError<ByteLimitExceeded>()("ByteLimitExceeded", {
  limit: Schema.Number,
  observedBytes: Schema.Number
}) {}

/** Pass chunks through unchanged; fail once the running total exceeds `limit`. */
export const limitBytes = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
): Stream.Stream<Uint8Array, E | ByteLimitExceeded, R> =>
  stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (total: number, chunk: Uint8Array) => {
        const observedBytes = total + chunk.byteLength
        if (observedBytes > limit) return Effect.fail(new ByteLimitExceeded({ limit, observedBytes }))
        const next: readonly [number, ReadonlyArray<Uint8Array>] = [observedBytes, [chunk]]
        return Effect.succeed(next)
      }
    )
  )

const concat = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

/** Collect a stream into one `Uint8Array`, failing as soon as it exceeds `limit` bytes. */
export const collectBounded = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
): Effect.Effect<Uint8Array, E | ByteLimitExceeded, R> =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = []
    let size = 0
    return limitBytes(stream, limit).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk)
          size += chunk.byteLength
        })
      ),
      Effect.map(() => concat(chunks, size))
    )
  })

/**
 * {@link collectBounded}, decoded as UTF-8 exactly as `Stream.decodeText` +
 * `Stream.mkString` would: invalid sequences become U+FFFD, and an incomplete
 * sequence at the very end is dropped rather than replaced, because
 * `decodeText` decodes in streaming mode and never flushes.
 */
export const collectBoundedText = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
): Effect.Effect<string, E | ByteLimitExceeded, R> =>
  collectBounded(stream, limit).pipe(Effect.map((body) => new TextDecoder().decode(body, { stream: true })))
