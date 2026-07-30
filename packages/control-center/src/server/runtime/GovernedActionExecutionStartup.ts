import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { Role } from "../../domain/actors.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import {
  GovernedActionPolicyBindingSource,
  GovernedActionProposalAuthority,
  GovernedActionSubmission,
  GovernedActionSubmissionUnavailable
} from "../governance/GovernedActionSubmission.js"
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
  GovernedActionPolicyEvaluator,
  makeBuiltInGovernedActionPolicyDefinitions,
  makeWorkspaceGovernedActionPolicyCatalogSource
} from "../governance/internal/GovernedActionPolicyEvaluator.js"
import { Persistence } from "../persistence/Persistence.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import { WorkspaceSettingsRepository } from "../persistence/repositories/workspaceSettingsRepository.js"
import { AuthorizedPluginExecutorMap } from "../plugins/internal/AuthorizedPluginExecutorMap.js"
import { PluginRuntimeAuthorityToken } from "../plugins/internal/PluginRuntimeAuthority.js"
import { pluginRuntimeAuthoritySourceLayer } from "../plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginRuntimeAuthoritySource } from "../plugins/internal/PluginRuntimeAuthoritySource.js"
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

const submissionUnavailable = () => new GovernedActionSubmissionUnavailable()

/** Keep provider execution private while accepting only a durable action identity. */
export const governedActionSubmissionLayer = Layer.effect(
  GovernedActionSubmission,
  Effect.map(GovernedActionExecutionStartup, (execution) =>
    GovernedActionSubmission.of({
      advance: (reference) =>
        execution._tag === "ready"
          ? execution.advance(reference).pipe(
            Effect.asVoid,
            Effect.tapError((cause) =>
              Effect.logError("Governed action submission failed", {
                actionId: reference.actionId,
                cause,
                workspaceId: reference.workspaceId
              })
            ),
            Effect.catch(() => Effect.fail(submissionUnavailable()))
          )
          : Effect.fail(submissionUnavailable())
    }))
)

/** Expose only the immutable server-owned policy binding to proposal constructors. */
export const governedActionPolicyBindingSourceLayer = Layer.effect(
  GovernedActionPolicyBindingSource,
  makeBuiltInGovernedActionPolicyDefinitions().pipe(
    Effect.map((definitions) => {
      const forPermission = (requiredPermission: Role) => {
        const definition = definitions.find(
          ({ binding }) => binding.requiredPermission === requiredPermission
        )
        return definition === undefined
          ? Effect.fail(submissionUnavailable())
          : Effect.succeed(definition.binding)
      }
      return {
        current: forPermission("workspace-owner"),
        forPermission
      }
    }),
    Effect.catch(() => Effect.fail(submissionUnavailable()))
  )
)

/** Expose D03 bindings derived from the exact current settings revision. */
export const workspaceGovernedActionPolicyBindingSourceLayer = (
  workspaceId: WorkspaceId
) =>
  Layer.effect(
    GovernedActionPolicyBindingSource,
    Effect.gen(function*() {
      const persistence = yield* Persistence
      const catalogs = yield* makeWorkspaceGovernedActionPolicyCatalogSource(
        persistence.workspaceSettings.get
      )
      const forPermission = (requiredPermission: Role) =>
        catalogs.get(workspaceId).pipe(
          Effect.mapError(() => submissionUnavailable()),
          Effect.flatMap(({ definitions }) => {
            const definition = definitions.find(
              ({ binding }) => binding.requiredPermission === requiredPermission
            )
            return definition === undefined
              ? Effect.fail(submissionUnavailable())
              : Effect.succeed(definition.binding)
          })
        )
      return {
        current: forPermission("workspace-owner"),
        forPermission
      }
    })
  )

/** Verify a proposal's exact runtime generation in the same transaction as its durable writes. */
export const governedActionProposalAuthorityLayer = Layer.effect(
  GovernedActionProposalAuthority,
  Effect.map(PluginRuntimeAuthoritySource, (authority) =>
    GovernedActionProposalAuthority.of({
      transactCurrent: (input, use) =>
        Schema.decodeUnknownEffect(PluginRuntimeAuthorityToken)(
          input.runtimeAuthorityToken
        ).pipe(
          Effect.mapError(() => submissionUnavailable()),
          Effect.flatMap((runtimeAuthorityToken) =>
            authority.transactCurrent(
              {
                scope: {
                  workspaceId: input.workspaceId,
                  pluginConnectionId: input.pluginConnectionId
                },
                runtimeAuthorityToken
              },
              use
            ).pipe(
              Effect.catchTag(
                "PluginRuntimeAuthorityUnavailable",
                () => Effect.fail(submissionUnavailable())
              ),
              Effect.catchTag(
                "PersistedRecordError",
                () => Effect.fail(submissionUnavailable())
              ),
              Effect.catchTag(
                "PersistenceOperationError",
                () => Effect.fail(submissionUnavailable())
              )
            )
          )
        )
    }))
)

/** Complete live proposal-authority boundary for server composition. */
export const governedActionProposalAuthorityLiveLayer = governedActionProposalAuthorityLayer.pipe(
  Layer.provide(pluginRuntimeAuthoritySourceLayer)
)

const readyLayersFromRuntimeMap = (workspaceId: WorkspaceId) => {
  const executors = AuthorizedPluginExecutorMap.layer
  const workspaceSettings = WorkspaceSettingsRepository.layer.pipe(
    Layer.provideMerge(QuarantineRepository.layer)
  )
  const store = governedActionExecutionStoreLayer(workspaceId).pipe(
    Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
    Layer.provideMerge(
      GovernedActionPolicyEvaluator.workspaceSettingsLayer.pipe(
        Layer.provide(workspaceSettings)
      )
    ),
    Layer.provideMerge(QuarantineRepository.layer)
  )
  const engine = GovernedActionExecutionEngine.layer.pipe(
    Layer.provide(store),
    Layer.provide(executors)
  )
  return {
    executors,
    startup: Layer.merge(
      Layer.effect(GovernedActionExecutionStartup, makeReadyStartup).pipe(
        Layer.provide(engine)
      ),
      governedActionRecoveryClaimDrainLayer(workspaceId)
    )
  }
}

const readyLayer = (options: GovernedActionExecutionStartupOptions) => {
  const registry = Layer.succeed(PluginRuntimeRegistry, options.pluginRuntimes)
  const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registry))
  return readyLayersFromRuntimeMap(options.workspaceId).startup.pipe(Layer.provide(runtimeMap))
}

/** Install the engine only when an internal runtime registry is explicitly configured. */
export const governedActionExecutionStartupLayer = (
  options: GovernedActionExecutionStartupOptions | null
) =>
  options === null
    ? Layer.succeed(GovernedActionExecutionStartup, { _tag: "disabled" })
    : readyLayer(options)

/** Resolve the internal plugin registry at server composition time. */
export const governedActionExecutionStartupFromRegistryLayer = (
  workspaceId: WorkspaceId
) =>
  Layer.unwrap(
    Effect.map(
      PluginRuntimeRegistry,
      (pluginRuntimes) => governedActionExecutionStartupLayer({ workspaceId, pluginRuntimes })
    )
  )

/** Resolve executors from the server-owned cache shared with proposal projections. @internal */
export const governedActionExecutionStartupFromRuntimeMapLayer = (
  workspaceId: WorkspaceId
) => readyLayersFromRuntimeMap(workspaceId).startup

/** Keep the exact private executor projection available to the server composition test. @internal */
export const governedActionExecutionRuntimeFromRuntimeMapLayers = (
  workspaceId: WorkspaceId
) => readyLayersFromRuntimeMap(workspaceId)

/** Acquire the private worker for server lifetime without returning its capability. */
export const governedActionExecutionServerLayer = (
  options: GovernedActionExecutionStartupOptions | null
) =>
  Layer.effectDiscard(GovernedActionExecutionStartup).pipe(
    Layer.provide(governedActionExecutionStartupLayer(options))
  )
