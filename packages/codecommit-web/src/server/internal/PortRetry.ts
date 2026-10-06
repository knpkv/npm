import { Effect, Predicate, Ref } from "effect"

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
  const nextPort = (defect: Error) =>
    Effect.gen(function*() {
      const remaining = yield* Ref.getAndUpdate(retriesRef, (r) => r - 1)
      if (remaining <= 0) return yield* Effect.die(defect)
      const p = yield* Ref.getAndUpdate(portRef, (prev) => prev + 1)
      yield* Effect.logWarning(`Port ${p} in use, trying ${p + 1}`)
    })
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchDefect((defect) =>
        Effect.flatMap(
          Ref.get(listening),
          (isListening) =>
            !isListening && Predicate.isError(defect) && defect.message.includes("port")
              ? nextPort(defect)
              : Effect.die(defect)
        )
      )
    )
}
