import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"

/** Remove a partial fixture after allocation failure while retaining both causes if cleanup also fails. */
export const protectPartialFixtureAllocation = <A, E, R, E2, R2>(
  allocation: Effect.Effect<A, E, R>,
  removePartialFixture: Effect.Effect<unknown, E2, R2>
): Effect.Effect<A, E | E2 | AggregateError, R | R2> =>
  Effect.matchCauseEffect(allocation, {
    onFailure: (allocationCause) =>
      Effect.matchCauseEffect(Effect.uninterruptible(removePartialFixture), {
        onFailure: (cleanupCause) => {
          const allocationFailure = Cause.squash(allocationCause)
          const cleanupFailure = Cause.squash(cleanupCause)
          return Effect.fail(
            new AggregateError(
              [allocationFailure, cleanupFailure],
              "real runtime partial allocation and cleanup both failed",
              { cause: cleanupFailure }
            )
          )
        },
        onSuccess: () => Effect.failCause(allocationCause)
      }),
    onSuccess: Effect.succeed
  })

/** Preserve both the initiating setup failure and any failure raised while cleaning it up. */
export const disposeFailedFixtureSetup = async (
  setupFailure: unknown,
  dispose: () => Promise<void>
): Promise<never> => {
  try {
    await dispose()
  } catch (cleanupFailure) {
    throw new AggregateError(
      [setupFailure, cleanupFailure],
      "real runtime fixture setup and teardown both failed",
      { cause: cleanupFailure }
    )
  }
  throw setupFailure
}
