import { Effect, Ref, Schema } from "effect"

/**
 * A bind refused because the port is taken. Node's server reports it as a typed `ServeError` whose
 * cause carries `EADDRINUSE`; Bun's as a defect whose message names the port.
 */
const PortTaken = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ServeError"), cause: Schema.Struct({ code: Schema.Literal("EADDRINUSE") }) }),
  Schema.Struct({ message: Schema.String.check(Schema.isPattern(/port/u)) })
])
const portTaken = Schema.is(PortTaken)

/**
 * Retry a bind that failed because its port is taken, until `listening` is set. Once the server is
 * listening its URL is out and the caller's `onReady` is running, so a later failure is not a port
 * conflict and must surface instead of re-minting credentials on the next port.
 */
export const updatePortOnConflict = (
  portRef: Ref.Ref<number>,
  retriesRef: Ref.Ref<number>,
  listening: Ref.Ref<boolean>
) => {
  /** Moves to the next port, or gives back `surface` once the retries are spent. */
  const nextPort = <E>(surface: Effect.Effect<never, E>) =>
    Effect.gen(function*() {
      const remaining = yield* Ref.getAndUpdate(retriesRef, (r) => r - 1)
      if (remaining <= 0) return yield* surface
      const p = yield* Ref.getAndUpdate(portRef, (prev) => prev + 1)
      yield* Effect.logWarning(`Port ${p} in use, trying ${p + 1}`)
    })
  const retryIfConflict = <E>(failure: Parameters<typeof portTaken>[0], surface: Effect.Effect<never, E>) =>
    Effect.flatMap(
      Ref.get(listening),
      (isListening) => !isListening && portTaken(failure) ? nextPort(surface) : surface
    )
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catch((error) => retryIfConflict(error, Effect.fail(error))),
      Effect.catchDefect((defect) => retryIfConflict(defect, Effect.die(defect)))
    )
}
