/** Own optional hue work beyond a request, with one in-flight allocation per connection. */
import { Effect, Exit, Fiber, Option, Ref, Schema, Scope } from "effect"
import { AgentActivityStore } from "./activity-store.js"
import { connectPeerDirectoryTimeoutMillis } from "./internal/peer-deadline.js"
import type { ConnectAgent } from "./model.js"

export const hueFinalizerShutdownTimeoutMillis = 2_000

export class HueFinalizerShutdownTimeout extends Schema.TaggedError<HueFinalizerShutdownTimeout>()(
  "HueFinalizerShutdownTimeout",
  { timeoutMillis: Schema.Number }
) {}

const optionalHueWaitMillis = connectPeerDirectoryTimeoutMillis / 2

type HueState = "idle" | "busy" | "closed"

export interface ConnectHueEnrichment {
  readonly assign: (
    host: string,
    agents: ReadonlyArray<ConnectAgent>,
    observedAt: number,
    complete: boolean
  ) => Effect.Effect<Option.Option<ReadonlyArray<ConnectAgent>>>
}

/**
 * Acquire once in the server scope. Assignment waits half the peer deadline, then returns None while owned work continues.
 * Busy and closed owners also return None; request cancellation only stops waiting. Each allocation retains its permit
 * through permission finalization. Scope closure interrupts work, joins for two seconds, then closes the connection and
 * logs HueFinalizerShutdownTimeout if uninterruptible cleanup remains pending. Such cleanup may settle after shutdown.
 */
export const makeConnectHueEnrichment = Effect.fn("ConnectHueEnrichment.make")(function*(path: string) {
  const scope = yield* Scope.make()
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  const state = yield* Ref.make<HueState>("idle")
  const store = yield* Effect.acquireRelease(
    AgentActivityStore.open(path),
    (opened) =>
      Effect.gen(function*() {
        yield* Ref.set(state, "closed")
        // Scope.close itself is uninterruptible. Bound its waiter, not its owned cleanup, so shutdown cannot rejoin forever.
        const closing = runPromise(Scope.close(scope, Exit.void))
        const joined = yield* Effect.promise(() => closing).pipe(
          Effect.timeoutOption(hueFinalizerShutdownTimeoutMillis),
          Effect.interruptible
        )
        if (Option.isNone(joined)) {
          yield* Effect.logWarning(
            new HueFinalizerShutdownTimeout({ timeoutMillis: hueFinalizerShutdownTimeoutMillis })
          )
        }
      }).pipe(Effect.ensuring(Effect.sync(() => opened.close())))
  )
  const assign: ConnectHueEnrichment["assign"] = Effect.fn("ConnectHueEnrichment.assign")(
    function*(host, agents, observedAt, complete) {
      const pending = yield* Effect.uninterruptible(Effect.gen(function*() {
        const admitted = yield* Ref.modify(
          state,
          (current) => [current === "idle", current === "idle" ? "busy" : current]
        )
        if (!admitted) return Option.none()
        const task = store.assignHues(host, agents, observedAt, complete).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) =>
            Effect.logWarning("ConnectHueAssignmentFailed", { host, cause: cause._tag }).pipe(
              Effect.as(Option.none())
            )
          ),
          Effect.ensuring(Ref.update(state, (current) => current === "busy" ? "idle" : current))
        )
        return Option.some(yield* Effect.forkIn(task, scope))
      }))
      if (Option.isNone(pending)) return Option.none()
      const result = yield* Fiber.await(pending.value).pipe(Effect.timeoutOption(optionalHueWaitMillis))
      return Option.isSome(result) && Exit.isSuccess(result.value) ? result.value.value : Option.none()
    }
  )
  return { assign } satisfies ConnectHueEnrichment
})
