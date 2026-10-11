/**
 * Byte-capped Effect streams.
 *
 * **Mental model**
 *
 * - A budget is a running total of `byteLength`. `limit` is inclusive: a stream of
 *   exactly `limit` bytes succeeds; the chunk that takes the total past it fails
 *   the stream with {@link ByteLimitExceeded}, and nothing after it is pulled.
 * - The `limit*`/`collectBounded*` functions fail on overflow and never truncate.
 *   `collectTail*` is the one deliberate exception: it keeps the last `limit`
 *   bytes and reports how many it dropped, for output whose end matters (a
 *   build log) and that nothing parses.
 * - Upstream failures pass through unchanged, so a caller maps
 *   `ByteLimitExceeded` to its own error and leaves the rest alone.
 * - `limit` must be a non-negative safe integer. An invalid one (`NaN`,
 *   `Infinity`, negative, fractional) is a programming error and dies with
 *   {@link InvalidByteLimit} instead of silently reading without a cap.
 * - Interrupting or failing a collection inside the caller's scope is what stops a
 *   child process; this module never spawns or kills anything itself.
 *
 * @module
 */
import { Data, Effect, Schema, Stream } from "effect"

/** A stream produced more than `limit` bytes; `observedBytes` is the total at the crossing chunk. */
export class ByteLimitExceeded extends Schema.TaggedError<ByteLimitExceeded>()("ByteLimitExceeded", {
  limit: Schema.Number,
  observedBytes: Schema.Number
}) {}

/**
 * A limit that is not a non-negative safe integer. Raised as a defect, before the
 * stream is pulled: a `NaN` or `Infinity` limit would otherwise disable the cap.
 */
export class InvalidByteLimit extends Data.TaggedError("InvalidByteLimit")<{ readonly limit: number }> {}

const isValidLimit = (limit: number): boolean => Number.isSafeInteger(limit) && limit >= 0

/**
 * Pass chunks through unchanged; fail once the running total exceeds `limit`.
 * `limit` must be a non-negative safe integer; anything else dies with
 * {@link InvalidByteLimit} before the stream is pulled.
 */
export const limitBytes = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
): Stream.Stream<Uint8Array, E | ByteLimitExceeded, R> =>
  isValidLimit(limit) ? capped(stream, limit) : Stream.die(new InvalidByteLimit({ limit }))

const capped = <E, R>(
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

/** What {@link collectTail} kept: the stream's last bytes, and how many came before them. */
export interface Tail {
  readonly bytes: Uint8Array
  readonly omittedBytes: number
}

/**
 * Collect a stream's last `limit` bytes, holding no more than that plus one
 * chunk at a time. Never fails for size: the stream runs to its end, which is
 * the point when a caller must not interrupt the producer (a child process
 * still writing). `limit` must be a non-negative safe integer; anything else
 * dies with {@link InvalidByteLimit} before the stream is pulled.
 */
export const collectTail = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
): Effect.Effect<Tail, E, R> =>
  isValidLimit(limit)
    ? Effect.suspend(() => {
      const chunks: Array<Uint8Array> = []
      let size = 0
      let omittedBytes = 0
      return stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk)
            size += chunk.byteLength
            while (size > limit) {
              const first = chunks[0]
              if (first === undefined) break
              const excess = size - limit
              const dropped = Math.min(excess, first.byteLength)
              if (dropped === first.byteLength) chunks.shift()
              else chunks[0] = first.subarray(dropped)
              size -= dropped
              omittedBytes += dropped
            }
          })
        ),
        Effect.map((): Tail => ({ bytes: concat(chunks, size), omittedBytes }))
      )
    })
    : Effect.die(new InvalidByteLimit({ limit }))

/** {@link collectTail} decoded as text; `omittedBytes` counts every byte not decoded. */
export interface TextTail {
  readonly text: string
  readonly omittedBytes: number
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80

/**
 * {@link collectTail}, decoded as {@link collectBoundedText} decodes. When bytes
 * were dropped, the kept tail first skips UTF-8 continuation bytes, so it starts
 * on a character boundary instead of with a replacement character.
 */
export const collectTailText = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number
): Effect.Effect<TextTail, E, R> =>
  collectTail(stream, limit).pipe(
    Effect.map(({ bytes, omittedBytes }): TextTail => {
      let start = 0
      if (omittedBytes > 0) {
        while (start < bytes.byteLength && isContinuationByte(bytes[start] ?? 0)) start += 1
      }
      return {
        text: new TextDecoder().decode(bytes.subarray(start), { stream: true }),
        omittedBytes: omittedBytes + start
      }
    })
  )
