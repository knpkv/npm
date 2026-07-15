import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { type GovernedActionState, type GovernedActionUnknownOutcome } from "../../../domain/governedAction/index.js"
import { GovernedActionId, WorkspaceId } from "../../../domain/identifiers.js"
import type {
  AuthorizedPluginActionV1,
  BlockedPluginActionPreflightV1,
  PluginActionDispatchResultV1,
  PluginActionReconciliationRequestV1,
  PluginActionReconciliationResultV1,
  ReadyPluginActionPreflightV1
} from "../../../domain/plugins/actions.js"
import type { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import type { PluginRuntimeAuthorityToken } from "../../plugins/internal/PluginRuntimeAuthority.js"
import type { PluginRuntimeScope } from "../../plugins/PluginConnectionMap.js"
import type {
  GovernedActionPermitToken,
  GovernedActionPreparationToken,
  GovernedActionRecoveryToken
} from "./execution-store/tokens.js"

/** Workspace-scoped action identity accepted by the sealed execution worker. */
export const GovernedActionExecutionReference = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId
})

/** Decoded execution identity. */
export type GovernedActionExecutionReference = typeof GovernedActionExecutionReference.Type

/** Closed failure from the atomic authority/start and durable outcome boundary. */
export class GovernedActionExecutionStoreError extends Schema.TaggedErrorClass<GovernedActionExecutionStoreError>()(
  "GovernedActionExecutionStoreError",
  {
    operation: Schema.Literals([
      "inspect",
      "begin",
      "block",
      "record-dispatch",
      "record-recovery-unavailable",
      "record-unknown",
      "record-reconciliation"
    ]),
    reason: Schema.Literals([
      "authority-changed",
      "conflict",
      "invalid-record",
      "not-found",
      "persistence-unavailable"
    ])
  }
) {}

export interface GovernedActionInactiveExecution {
  readonly _tag: "inactive"
  readonly state: GovernedActionState
}

/** Immutable preparation data only; it grants no provider execution authority. */
export interface GovernedActionDispatchPreparation {
  readonly _tag: "dispatch"
  readonly preparationToken: GovernedActionPreparationToken
  readonly scope: PluginRuntimeScope
  readonly request: AuthorizedPluginActionV1
}

/** Recovery plan for durable started/unknown work; reconciliation never replays the mutation. */
export interface GovernedActionRecoveryPreparation {
  readonly _tag: "reconcile"
  readonly recoveryToken: GovernedActionRecoveryToken
  readonly runtimeAuthorityToken: PluginRuntimeAuthorityToken
  readonly scope: PluginRuntimeScope
  readonly request: PluginActionReconciliationRequestV1
}

export type GovernedActionExecutionPlan =
  | GovernedActionInactiveExecution
  | GovernedActionDispatchPreparation
  | GovernedActionRecoveryPreparation

/** One-use permit returned only by an atomic live-authority verification plus start commit. */
export interface GovernedActionDispatchPermit {
  readonly _tag: "permitted"
  readonly permitToken: GovernedActionPermitToken
  readonly runtimeAuthorityToken: PluginRuntimeAuthorityToken
  readonly dispatchDeadline: UtcTimestamp
  readonly leaseExpiresAt: UtcTimestamp
  readonly recovery: {
    readonly strategy: "idempotency"
    readonly capabilityVersion: 1
  }
  readonly scope: PluginRuntimeScope
  readonly request: AuthorizedPluginActionV1
}

export type GovernedActionBeginResult = GovernedActionInactiveExecution | GovernedActionDispatchPermit

/**
 * Persistence-side half of governed execution.
 *
 * `begin` must reload session, evidence, target, policy, and plugin authority in one database
 * snapshot, sample its trusted clock, match the leased runtime authority token, require negotiated
 * idempotency reconciliation, and atomically commit `started` plus a recovery lease; replay never
 * returns `permitted`. The returned provider-call deadline must be strictly before lease expiry.
 * While that lease is live `inspect` returns inactive. Recovery becomes eligible only after lease
 * expiry plus a safety interval that exceeds the maximum provider-call deadline; an immediate
 * not-found after timeout is never terminal. Recovery plans retain the exact runtime-authority
 * token that owned dispatch. Outcome methods
 * must append the provider result to a durable inbox before folding the current lifecycle head,
 * so concurrent cancellation cannot discard a receipt. `inspect` must return `reconcile` for
 * stranded `started` work, using a null reconciliation key to recover by idempotency identity.
 */
export interface GovernedActionExecutionStoreV1 {
  readonly inspect: (
    reference: GovernedActionExecutionReference
  ) => Effect.Effect<GovernedActionExecutionPlan, GovernedActionExecutionStoreError>
  readonly begin: (input: {
    readonly preparationToken: GovernedActionPreparationToken
    readonly preflight: ReadyPluginActionPreflightV1
    readonly runtimeAuthorityToken: PluginRuntimeAuthorityToken
    readonly scope: PluginRuntimeScope
  }) => Effect.Effect<GovernedActionBeginResult, GovernedActionExecutionStoreError>
  readonly recordBlocked: (input: {
    readonly preparationToken: GovernedActionPreparationToken
    readonly preflight: BlockedPluginActionPreflightV1
    readonly observedAt: UtcTimestamp
  }) => Effect.Effect<GovernedActionState, GovernedActionExecutionStoreError>
  readonly recordDispatch: (input: {
    readonly permitToken: GovernedActionPermitToken
    readonly result: PluginActionDispatchResultV1
    readonly observedAt: UtcTimestamp
  }) => Effect.Effect<GovernedActionState, GovernedActionExecutionStoreError>
  readonly recordUnknown: (input: {
    readonly permitToken: GovernedActionPermitToken
    readonly outcome: GovernedActionUnknownOutcome
  }) => Effect.Effect<GovernedActionState, GovernedActionExecutionStoreError>
  readonly recordRecoveryUnavailable: (input: {
    readonly recoveryToken: GovernedActionRecoveryToken
    readonly observedAt: UtcTimestamp
    readonly reason: "runtime-generation-unavailable"
  }) => Effect.Effect<GovernedActionState, GovernedActionExecutionStoreError>
  readonly recordReconciliation: (input: {
    readonly recoveryToken: GovernedActionRecoveryToken
    readonly result: PluginActionReconciliationResultV1
    readonly observedAt: UtcTimestamp
  }) => Effect.Effect<GovernedActionState, GovernedActionExecutionStoreError>
}

/** Internal atomic authority and outcome port; no route or agent layer may provide it. */
export class GovernedActionExecutionStore extends Context.Service<
  GovernedActionExecutionStore,
  GovernedActionExecutionStoreV1
>()("@knpkv/control-center/internal/GovernedActionExecutionStore") {}
