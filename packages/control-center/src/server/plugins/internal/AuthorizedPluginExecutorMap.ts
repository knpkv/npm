import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"

import type { PluginFailure } from "../failures.js"
import type { PluginRuntimeScope } from "../PluginConnectionMap.js"
import { AuthorizedPluginExecutor } from "./AuthorizedPluginExecutor.js"
import {
  PluginRuntimeAuthority,
  type PluginRuntimeAuthorityToken,
  PluginRuntimeAuthorityUnavailable
} from "./PluginRuntimeAuthority.js"
import { pluginRuntimeKey, PluginRuntimeMap } from "./PluginRuntimeMap.js"

export { PluginRuntimeAuthorityUnavailable } from "./PluginRuntimeAuthority.js"

/** Executor and exact runtime generation held under one shared scoped lease. */
export interface AuthorizedPluginExecutorLease {
  readonly context: Context.Context<AuthorizedPluginExecutor>
  readonly runtimeAuthorityToken: PluginRuntimeAuthorityToken
}

/** Internal projection of a cached runtime's vendor-write capability. */
export interface AuthorizedPluginExecutorMapV1 {
  readonly contextEffect: (
    scope: PluginRuntimeScope
  ) => Effect.Effect<AuthorizedPluginExecutorLease, PluginFailure, Scope.Scope>
  readonly contextEffectForAuthority: (
    scope: PluginRuntimeScope,
    runtimeAuthorityToken: PluginRuntimeAuthorityToken
  ) => Effect.Effect<AuthorizedPluginExecutorLease, PluginFailure | PluginRuntimeAuthorityUnavailable, Scope.Scope>
  readonly invalidate: (scope: PluginRuntimeScope) => Effect.Effect<void>
}

/** Internal-only executor lookup used later by the governed action engine. */
export class AuthorizedPluginExecutorMap extends Context.Service<
  AuthorizedPluginExecutorMap,
  AuthorizedPluginExecutorMapV1
>()("@knpkv/control-center/internal/AuthorizedPluginExecutorMap") {
  static readonly layer = Layer.effect(
    AuthorizedPluginExecutorMap,
    Effect.map(PluginRuntimeMap, (runtimeMap) => {
      const contextEffect = (scope: PluginRuntimeScope) =>
        Effect.map(runtimeMap.contextEffect(pluginRuntimeKey(scope)), (context) => ({
          context: Context.make(AuthorizedPluginExecutor, Context.get(context, AuthorizedPluginExecutor)),
          runtimeAuthorityToken: Context.get(context, PluginRuntimeAuthority)
        }))
      return {
        contextEffect,
        contextEffectForAuthority: (scope, runtimeAuthorityToken) =>
          Effect.flatMap(contextEffect(scope), (lease) =>
            lease.runtimeAuthorityToken === runtimeAuthorityToken
              ? Effect.succeed(lease)
              : Effect.fail(new PluginRuntimeAuthorityUnavailable())),
        invalidate: (scope: PluginRuntimeScope) => runtimeMap.invalidate(pluginRuntimeKey(scope))
      }
    })
  )
}
