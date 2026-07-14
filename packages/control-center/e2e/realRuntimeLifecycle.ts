import * as Effect from "effect/Effect"

/** Remove a partially allocated fixture when a later allocation step fails. */
export const protectPartialFixtureAllocation = <A, E, R>(
  allocation: Effect.Effect<A, E, R>,
  removePartialFixture: Effect.Effect<unknown, never>
): Effect.Effect<A, E, R> => allocation.pipe(Effect.onError(() => removePartialFixture))

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
