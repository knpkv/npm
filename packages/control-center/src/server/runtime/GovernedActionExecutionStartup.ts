import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../domain/identifiers.js"
import { governedActionExecutionStoreLayer } from "../governance/internal/execution-store/live.js"
import { makeGovernedActionRecoveryClaimExpiry } from "../governance/internal/execution-store/recovery-claim-expiry.js"
import {
  GovernedActionExecutionEngine,
  type GovernedActionExecutionEngineService,
  type GovernedActionRecoverySweepResult
} from "../governance/internal/GovernedActionExecutionEngine.js"
import type { GovernedActionExecutionStoreError } from "../governance/internal/GovernedActionExecutionStore.js"
import {
  type GovernedActionPolicyCatalogInvalid,
  GovernedActionPolicyEvaluator
} from "../governance/internal/GovernedActionPolicyEvaluator.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import { AuthorizedPluginExecutorMap } from "../plugins/internal/AuthorizedPluginExecutorMap.js"
import { pluginRuntimeAuthoritySourceLayer } from "../plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginRuntimeMap } from "../plugins/internal/PluginRuntimeMap.js"
import { PluginRuntimeRegistry, type PluginRuntimeRegistryV1 } from "../plugins/internal/PluginRuntimeRegistry.js"
import { type ServerDraining, ServerLifecycle } from "./ServerLifecycle.js"

/** Server-owned runtime factories; this grants no route or agent an execution handle. */
export interface GovernedActionExecutionStartupOptions {
  readonly pluginRuntimes: PluginRuntimeRegistryV1
  readonly workspaceId: WorkspaceId
}

/** Failures that can prevent the private governed worker from being constructed. */
export type GovernedActionExecutionStartupError =
  | GovernedActionExecutionStoreError
  | GovernedActionPolicyCatalogInvalid
  | ServerDraining

/** Private worker state; import boundaries keep `advance` out of APIs and agent adapters. */
export type GovernedActionExecutionStartupState =
  | { readonly _tag: "disabled" }
  | {
    readonly _tag: "ready"
    readonly advance: GovernedActionExecutionEngineService["run"]
    readonly recovery: GovernedActionRecoverySweepResult
  }

const makeReadyStartup = Effect.gen(function*() {
  const engine = yield* GovernedActionExecutionEngine
  const lifecycle = yield* ServerLifecycle
  const recovery = yield* lifecycle.runBackground(engine.recoverEligible())
  return {
    _tag: "ready",
    advance: engine.run,
    recovery
  } satisfies GovernedActionExecutionStartupState
})

/** Register governed-action recovery-claim expiry behind the shared drain barrier. */
export const governedActionRecoveryClaimDrainLayer = (workspaceId: WorkspaceId) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const expiry = yield* makeGovernedActionRecoveryClaimExpiry(workspaceId)
      const lifecycle = yield* ServerLifecycle

      yield* lifecycle.registerDrainHook({
        hookId: "governance.recovery-claim-expiry",
        run: DateTime.now.pipe(
          Effect.flatMap(expiry.expire),
          Effect.asVoid,
          Effect.orDie
        )
      })
    })
  )

/** Private worker composition result retained only by the server runtime. */
export class GovernedActionExecutionStartup extends Context.Service<
  GovernedActionExecutionStartup,
  GovernedActionExecutionStartupState
>()("@knpkv/control-center/server/runtime/GovernedActionExecutionStartup") {}

const readyLayer = (options: GovernedActionExecutionStartupOptions) => {
  const registry = Layer.succeed(PluginRuntimeRegistry, options.pluginRuntimes)
  const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registry))
  const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
  const store = governedActionExecutionStoreLayer(options.workspaceId).pipe(
    Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
    Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
    Layer.provideMerge(QuarantineRepository.layer)
  )
  const engine = GovernedActionExecutionEngine.layer.pipe(
    Layer.provide(store),
    Layer.provide(executors)
  )
  return Layer.merge(
    Layer.effect(GovernedActionExecutionStartup, makeReadyStartup).pipe(
      Layer.provide(engine)
    ),
    governedActionRecoveryClaimDrainLayer(options.workspaceId)
  )
}

/** Install the engine only when an internal runtime registry is explicitly configured. */
export const governedActionExecutionStartupLayer = (
  options: GovernedActionExecutionStartupOptions | null
) =>
  options === null
    ? Layer.succeed(GovernedActionExecutionStartup, { _tag: "disabled" })
    : readyLayer(options)

/** Acquire the private worker for server lifetime without returning its capability. */
export const governedActionExecutionServerLayer = (
  options: GovernedActionExecutionStartupOptions | null
) =>
  Layer.effectDiscard(GovernedActionExecutionStartup).pipe(
    Layer.provide(governedActionExecutionStartupLayer(options))
  )
