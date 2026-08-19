import type { Effect as EffectType, Fiber } from "effect"
import { Context, Effect, Layer } from "effect"

export interface SandboxWorkerScopeContract {
  readonly fork: <A, E, R>(
    worker: EffectType.Effect<A, E, R>
  ) => EffectType.Effect<Fiber.Fiber<A, E>, never, R>
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
        fork: (worker) => Effect.forkIn(worker, scope)
      }))
  )
}
