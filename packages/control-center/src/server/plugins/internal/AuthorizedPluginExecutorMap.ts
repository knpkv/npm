import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"

import type { PluginFailure } from "../failures.js"
import type { PluginRuntimeScope } from "../PluginConnectionMap.js"
import { AuthorizedPluginExecutor } from "./AuthorizedPluginExecutor.js"
import { pluginRuntimeKey, PluginRuntimeMap } from "./PluginRuntimeMap.js"

/** Internal projection of a cached runtime's vendor-write capability. */
export interface AuthorizedPluginExecutorMapV1 {
  readonly contextEffect: (
    scope: PluginRuntimeScope
  ) => Effect.Effect<Context.Context<AuthorizedPluginExecutor>, PluginFailure, Scope.Scope>
  readonly invalidate: (scope: PluginRuntimeScope) => Effect.Effect<void>
}

/** Internal-only executor lookup used later by the governed action engine. */
export class AuthorizedPluginExecutorMap extends Context.Service<
  AuthorizedPluginExecutorMap,
  AuthorizedPluginExecutorMapV1
>()("@knpkv/control-center/internal/AuthorizedPluginExecutorMap") {
  static readonly layer = Layer.effect(
    AuthorizedPluginExecutorMap,
    Effect.map(PluginRuntimeMap, (runtimeMap) => ({
      contextEffect: (scope: PluginRuntimeScope) =>
        Effect.map(
          runtimeMap.contextEffect(pluginRuntimeKey(scope)),
          (context) => Context.make(AuthorizedPluginExecutor, Context.get(context, AuthorizedPluginExecutor))
        ),
      invalidate: (scope: PluginRuntimeScope) => runtimeMap.invalidate(pluginRuntimeKey(scope))
    }))
  )
}
