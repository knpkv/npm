import type { Effect as EffectType, Fiber } from "effect"
import { Context, Deferred, Effect, Layer } from "effect"

export interface SandboxWorkerHandle<A, E> {
  readonly fiber: Fiber.Fiber<A, E>
  /** Completes only after the forked effect has entered its lifecycle. */
  readonly started: EffectType.Effect<void>
}

export interface SandboxWorkerScopeContract {
  readonly fork: <A, E, R>(
    worker: EffectType.Effect<A, E, R>
  ) => EffectType.Effect<SandboxWorkerHandle<A, E>, never, R>
}

/**
 * Scope owning asynchronous sandbox creation workers.
 *
 * @internal
 */
export class SandboxWorkerScope extends Context.Service<SandboxWorkerScope, SandboxWorkerScopeContract>()(
  "@knpkv/codecommit-core/SandboxWorkerScope"
) {
  /** @internal */
  static readonly Default = Layer.effect(
    SandboxWorkerScope,
    Effect.map(Effect.scope, (scope) =>
      SandboxWorkerScope.of({
        fork: (worker) =>
          Effect.gen(function*() {
            const started = yield* Deferred.make<void>()
            const fiber = yield* Effect.forkIn(
              Effect.uninterruptible(Deferred.succeed(started, undefined)).pipe(Effect.andThen(worker)),
              scope
            )
            return { fiber, started: Deferred.await(started) }
          })
      }))
  )
}
