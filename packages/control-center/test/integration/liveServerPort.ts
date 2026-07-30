import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { createServer } from "node:net"

/** The live fixture could not acquire an ephemeral loopback port. */
export class LiveIntegrationPortError extends Schema.TaggedErrorClass<LiveIntegrationPortError>()(
  "LiveIntegrationPortError",
  {
    reason: Schema.Literal("ephemeral-port-unavailable")
  }
) {}

const acquireEphemeralPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        if (address === null || typeof address === "string") {
          probe.close()
          reject(new Error("ephemeral listener did not expose an internet port"))
          return
        }
        probe.close((error) => error === undefined ? resolve(address.port) : reject(error))
      })
    }),
  catch: () => new LiveIntegrationPortError({ reason: "ephemeral-port-unavailable" })
})

const isAddressInUseFailure = (failure: unknown): boolean => {
  if (Predicate.hasProperty(failure, "code") && failure.code === "EADDRINUSE") return true
  return Predicate.hasProperty(failure, "cause") && isAddressInUseFailure(failure.cause)
}

/**
 * Reacquire an ephemeral port only when server startup loses the bind race.
 *
 * The injectable acquisition effect keeps the retry invariant independently
 * testable without creating external resources.
 */
export const startWithRetriedPort = <
  Value,
  StartError,
  StartRequirements,
  AcquireError,
  AcquireRequirements
>(
  acquirePort: Effect.Effect<number, AcquireError, AcquireRequirements>,
  start: (port: number) => Effect.Effect<Value, StartError, StartRequirements>
): Effect.Effect<
  { readonly port: number; readonly value: Value },
  StartError | AcquireError,
  StartRequirements | AcquireRequirements | Scope.Scope
> =>
  Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    const attempt = Effect.gen(function*() {
      const port = yield* acquirePort
      const attemptScope = yield* Scope.fork(parentScope)
      return yield* start(port).pipe(
        Scope.provide(attemptScope),
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Scope.close(attemptScope, Exit.failCause(cause)).pipe(
              Effect.andThen(Effect.failCause(cause))
            ),
          onSuccess: (value) => Effect.succeed({ port, value })
        })
      )
    })
    return yield* attempt.pipe(
      Effect.retry({ times: 2, while: isAddressInUseFailure })
    )
  })

/** Start the live server with bounded recovery from a lost port bind race. */
export const startWithRetriedEphemeralPort = <Value, Error, Requirements>(
  start: (port: number) => Effect.Effect<Value, Error, Requirements>
): Effect.Effect<
  { readonly port: number; readonly value: Value },
  Error | LiveIntegrationPortError,
  Requirements | Scope.Scope
> => startWithRetriedPort(acquireEphemeralPort, start)
