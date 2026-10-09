import * as Effect from "effect/Effect"

/** Counts `effect` as Relay answering for as long as it runs, however it ends. */
export const answeringWhile = (begin: () => () => void) => <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const end = begin()
    return effect.pipe(Effect.ensuring(Effect.sync(end)))
  })
