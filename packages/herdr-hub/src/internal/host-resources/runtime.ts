import { Deferred, Effect, Ref, Schedule } from "effect"
import { type HostResources, resourcesIntervalMillis } from "../../host-resources-model.js"

/** One sampler per server scope, including its first read before any request arrives. */
export const startResourcesSampler = Effect.fn("HostResources.startSampler")(
  function*<R>(sample: Effect.Effect<HostResources, never, R>) {
    const latest = yield* Ref.make<HostResources | null>(null)
    const first = yield* Deferred.make<HostResources>()
    const scope = yield* Effect.scope
    yield* sample.pipe(
      Effect.tap((snapshot) => Ref.set(latest, snapshot)),
      Effect.tap((snapshot) => Deferred.succeed(first, snapshot)),
      Effect.repeat(Schedule.fixed(resourcesIntervalMillis)),
      Effect.forkIn(scope)
    )
    return {
      read: Ref.get(latest).pipe(
        Effect.flatMap((snapshot) => snapshot === null ? Deferred.await(first) : Effect.succeed(snapshot))
      )
    }
  }
)
