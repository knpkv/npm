/**
 * The attached app's stdin: line 1 is the hub's {@link HubHandshake}; after it, stdin only signals stop.
 *
 * **Mental model**
 *
 * - The hub writes one JSON line at spawn and keeps the pipe open. The app waits at most 5 s for it and reads at
 *   most 4 KiB, so a process started by hand with `--attach` and no hub exits with a message instead of hanging.
 * - After line 1, further bytes are read and dropped. The end of stdin (the hub stopped it, or the hub died) is
 *   the app's stop signal: `closed` completes and the runner shuts its listener down.
 *
 * @module
 */
import { Deferred, Effect, Fiber, type PlatformError, Ref, Schema, Stream } from "effect"
import { AppStartError, HubHandshake } from "./manifest.js"

/** How long the app waits for line 1, and its largest size. */
export const handshakeLimits = { millis: 5_000, bytes: 4_096 }

const decodeHandshake = Schema.decodeUnknownEffect(Schema.fromJsonString(HubHandshake))
const handshakeError = (cause: unknown) => new AppStartError({ reason: "handshake", cause })

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)
  return joined
}

/**
 * Start reading `stdin` in the caller's scope. `handshake` is line 1 (or `AppStartError{handshake}`); `closed`
 * completes when stdin ends.
 */
export const readHandshake = Effect.fn("HubApp.readHandshake")(function*(
  stdin: Stream.Stream<Uint8Array, PlatformError.PlatformError>
) {
  const first = yield* Deferred.make<HubHandshake, AppStartError>()
  // The bytes of line 1 read so far, or null once line 1 is decided.
  const pending = yield* Ref.make<Uint8Array | null>(new Uint8Array(0))
  const take = (chunk: Uint8Array) =>
    Ref.modify(pending, (buffer): readonly [Effect.Effect<unknown>, Uint8Array | null] => {
      if (buffer === null) return [Effect.void, null]
      const joined = concat(buffer, chunk)
      const newline = joined.indexOf(10)
      if (newline === -1 || newline > handshakeLimits.bytes) {
        return joined.length > handshakeLimits.bytes
          ? [Deferred.fail(first, handshakeError("the handshake line is over 4 KiB")), null]
          : [Effect.void, joined]
      }
      const line = new TextDecoder().decode(joined.subarray(0, newline))
      return [Deferred.complete(first, decodeHandshake(line).pipe(Effect.mapError(handshakeError))), null]
    }).pipe(Effect.flatten)
  const reader = yield* stdin.pipe(
    Stream.runForEach(take),
    Effect.exit,
    Effect.andThen(Deferred.fail(first, handshakeError("stdin closed before the handshake"))),
    Effect.forkScoped
  )
  return {
    handshake: Deferred.await(first).pipe(
      Effect.timeoutOrElse({
        duration: handshakeLimits.millis,
        orElse: () => Effect.fail(handshakeError("no handshake within 5 seconds: start this app from the hub"))
      })
    ),
    closed: Fiber.await(reader).pipe(Effect.asVoid)
  }
})
