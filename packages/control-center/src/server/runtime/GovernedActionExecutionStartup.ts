import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { governedActionExecutionStoreLayer } from "../governance/internal/execution-store/live.js"
import {
  GovernedActionExecutionEngine,
  type GovernedActionExecutionEngineService
} from "../governance/internal/GovernedActionExecutionEngine.js"
import {
  type GovernedActionPolicyCatalogInvalid,
  GovernedActionPolicyEvaluator
} from "../governance/internal/GovernedActionPolicyEvaluator.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import { AuthorizedPluginExecutorMap } from "../plugins/internal/AuthorizedPluginExecutorMap.js"
import { pluginRuntimeAuthoritySourceLayer } from "../plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginRuntimeMap } from "../plugins/internal/PluginRuntimeMap.js"
import { PluginRuntimeRegistry, type PluginRuntimeRegistryV1 } from "../plugins/internal/PluginRuntimeRegistry.js"

/** Server-owned runtime factories; this grants no route or agent an execution handle. */
export interface GovernedActionExecutionStartupOptions {
  readonly pluginRuntimes: PluginRuntimeRegistryV1
}

/** Failures that can prevent the private governed worker from being constructed. */
export type GovernedActionExecutionStartupError = GovernedActionPolicyCatalogInvalid

/** Private worker state; import boundaries keep `advance` out of APIs and agent adapters. */
export type GovernedActionExecutionStartupState =
  | { readonly _tag: "disabled" }
  | {
    readonly _tag: "ready"
    readonly advance: GovernedActionExecutionEngineService["run"]
  }

const makeReadyStartup = Effect.gen(function*() {
  const engine = yield* GovernedActionExecutionEngine
  return {
    _tag: "ready",
    advance: engine.run
  } satisfies GovernedActionExecutionStartupState
})

/** Private worker composition result retained only by the server runtime. */
export class GovernedActionExecutionStartup extends Context.Service<
  GovernedActionExecutionStartup,
  GovernedActionExecutionStartupState
>()("@knpkv/control-center/server/runtime/GovernedActionExecutionStartup") {}

const readyLayer = (options: GovernedActionExecutionStartupOptions) => {
  const registry = Layer.succeed(PluginRuntimeRegistry, options.pluginRuntimes)
  const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registry))
  const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
  const store = governedActionExecutionStoreLayer.pipe(
    Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
    Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
    Layer.provideMerge(QuarantineRepository.layer)
  )
  const engine = GovernedActionExecutionEngine.layer.pipe(
    Layer.provide(store),
    Layer.provide(executors)
  )
  return Layer.effect(GovernedActionExecutionStartup, makeReadyStartup).pipe(
    Layer.provide(engine)
  )
}

/** Install the engine only when an internal runtime registry is explicitly configured. */
export const governedActionExecutionStartupLayer = (
  options: GovernedActionExecutionStartupOptions | null
) =>
  options === null
    ? Layer.succeed(GovernedActionExecutionStartup, { _tag: "disabled" })
    : readyLayer(options)
