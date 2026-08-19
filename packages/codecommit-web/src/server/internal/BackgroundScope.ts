import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"

/**
 * Application-owned scope for handler work that must outlive an individual
 * request while still being interrupted when the server layer shuts down.
 *
 * @internal
 */
export class BackgroundScope extends Context.Service<BackgroundScope, Scope.Scope>()(
  "@knpkv/codecommit-web/BackgroundScope"
) {}

/** @internal */
export const BackgroundScopeLive = Layer.effect(
  BackgroundScope,
  Effect.map(Effect.scope, BackgroundScope.of)
)
