import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { GovernedActionState, GovernedActionUnknownOutcome } from "../../../domain/governedAction/index.js"
import type { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import type { PluginFailure } from "../../plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../plugins/internal/AuthorizedPluginExecutor.js"
import { AuthorizedPluginExecutorMap } from "../../plugins/internal/AuthorizedPluginExecutorMap.js"
import type { AuthorizedPluginExecutorLease } from "../../plugins/internal/AuthorizedPluginExecutorMap.js"
import type { PluginRuntimeAuthorityToken } from "../../plugins/internal/PluginRuntimeAuthority.js"
import {
  type GovernedActionDispatchPermit,
  type GovernedActionDispatchPreparation,
  GovernedActionExecutionReference,
  type GovernedActionExecutionReference as GovernedActionExecutionReferenceType,
  GovernedActionExecutionStore,
  type GovernedActionRecoveryPreparation
} from "./GovernedActionExecutionStore.js"

/** Invalid untrusted action identity at the private worker boundary. */
export class GovernedActionExecutionInputError extends Schema.TaggedErrorClass<GovernedActionExecutionInputError>()(
  "GovernedActionExecutionInputError",
  {}
) {}

/** The durable provider-call window closed before a confirmed result was received. */
class GovernedActionDispatchDeadlineExceeded extends Schema.TaggedErrorClass<GovernedActionDispatchDeadlineExceeded>()(
  "GovernedActionDispatchDeadlineExceeded",
  {}
) {}

/** The recovery claim expired before the provider reconciliation completed. */
class GovernedActionReconciliationDeadlineExceeded
  extends Schema.TaggedErrorClass<GovernedActionReconciliationDeadlineExceeded>()(
    "GovernedActionReconciliationDeadlineExceeded",
    {}
  )
{}

/** Stable result of advancing one action without exposing an execution capability. */
export type GovernedActionExecutionResult =
  | { readonly _tag: "inactive"; readonly state: GovernedActionState }
  | { readonly _tag: "advanced"; readonly state: GovernedActionState }

/** Bounded process-start reconciliation outcome without action payloads or provider data. */
export interface GovernedActionRecoverySweepResult {
  readonly advanced: number
  readonly attempted: number
  readonly failed: number
  readonly inactive: number
}

const manualUnknown = (
  observedAt: UtcTimestamp,
  reason:
    | "dispatch-deadline-exceeded"
    | "interrupted-after-intent"
    | "missing-reconciliation-locator"
    | "provider-defect-after-intent"
): GovernedActionUnknownOutcome => ({
  _tag: "manual",
  observedAt,
  safeSummary: reason === "dispatch-deadline-exceeded"
    ? "Provider dispatch exceeded its durable execution deadline"
    : reason === "missing-reconciliation-locator"
    ? "Provider dispatch failed after durable intent without a reconciliation locator"
    : reason === "interrupted-after-intent"
    ? "Provider dispatch was interrupted after durable intent"
    : "Provider executor failed abnormally after durable intent",
  reason
})

const failureUnknown = (
  failure: PluginFailure,
  observedAt: UtcTimestamp
): GovernedActionUnknownOutcome =>
  failure._tag === "PluginUnknownOutcomeFailure"
    ? {
      _tag: "reconcilable",
      reconciliationKey: failure.reconciliationKey,
      observedAt,
      safeSummary: "Provider outcome is ambiguous and queued for reconciliation"
    }
    : manualUnknown(observedAt, "missing-reconciliation-locator")

const makeGovernedActionExecutionEngine = Effect.gen(function*() {
  const executors = yield* AuthorizedPluginExecutorMap
  const store = yield* GovernedActionExecutionStore

  const withExecutor = <Value, Failure>(
    scope: GovernedActionDispatchPreparation["scope"],
    use: (lease: AuthorizedPluginExecutorLease) => Effect.Effect<Value, Failure>
  ) =>
    Effect.scoped(Effect.gen(function*() {
      const lease = yield* executors.contextEffect(scope)
      return yield* use(lease)
    }))

  const withExecutorForAuthority = <Value, Failure>(
    scope: GovernedActionRecoveryPreparation["scope"],
    runtimeAuthorityToken: PluginRuntimeAuthorityToken,
    use: (lease: AuthorizedPluginExecutorLease) => Effect.Effect<Value, Failure>
  ) =>
    Effect.scoped(Effect.gen(function*() {
      const lease = yield* executors.contextEffectForAuthority(scope, runtimeAuthorityToken)
      return yield* use(lease)
    }))

  const persistAbnormalExit = (
    permit: GovernedActionDispatchPermit,
    reason: "interrupted-after-intent" | "provider-defect-after-intent"
  ) =>
    Effect.uninterruptible(DateTime.now.pipe(
      Effect.flatMap((observedAt) =>
        store.recordUnknown({
          permitToken: permit.permitToken,
          outcome: manualUnknown(observedAt, reason)
        })
      )
    ))

  const dispatch = Effect.fn("GovernedActionExecutionEngine.dispatch")(function*(
    preparation: GovernedActionDispatchPreparation
  ) {
    return yield* withExecutor(preparation.scope, (lease) =>
      Effect.gen(function*() {
        const executor = Context.get(lease.context, AuthorizedPluginExecutor)
        const preflight = yield* executor.preflight(preparation.request)
        const observedAt = yield* DateTime.now
        if (preflight._tag === "blocked") {
          const state = yield* store.recordBlocked({
            preparationToken: preparation.preparationToken,
            preflight,
            observedAt,
            scope: preparation.scope
          })
          return { _tag: "advanced", state } satisfies GovernedActionExecutionResult
        }

        const begun = yield* store.begin({
          preparationToken: preparation.preparationToken,
          preflight,
          runtimeAuthorityToken: lease.runtimeAuthorityToken,
          scope: preparation.scope
        })
        if (begun._tag === "inactive") return begun satisfies GovernedActionExecutionResult
        if (
          begun.runtimeAuthorityToken !== lease.runtimeAuthorityToken ||
          begun.scope.workspaceId !== preparation.scope.workspaceId ||
          begun.scope.pluginConnectionId !== preparation.scope.pluginConnectionId
        ) {
          return yield* new GovernedActionExecutionInputError()
        }
        const deadlineMillis = DateTime.toEpochMillis(begun.dispatchDeadline)
        if (deadlineMillis >= DateTime.toEpochMillis(begun.leaseExpiresAt)) {
          return yield* new GovernedActionExecutionInputError()
        }
        const remainingMillis = deadlineMillis - DateTime.toEpochMillis(yield* DateTime.now)
        if (remainingMillis <= 0) {
          const failedAt = yield* DateTime.now
          const state = yield* store.recordUnknown({
            permitToken: begun.permitToken,
            outcome: manualUnknown(failedAt, "dispatch-deadline-exceeded")
          })
          return { _tag: "advanced", state } satisfies GovernedActionExecutionResult
        }

        const providerResult = yield* executor.executeAuthorizedAction(begun.request).pipe(
          Effect.timeoutOrElse({
            duration: remainingMillis,
            orElse: () => Effect.fail(new GovernedActionDispatchDeadlineExceeded())
          }),
          Effect.onInterrupt(() => persistAbnormalExit(begun, "interrupted-after-intent")),
          Effect.result,
          Effect.catchCause((cause) =>
            persistAbnormalExit(begun, "provider-defect-after-intent").pipe(
              Effect.andThen(Effect.failCause(cause))
            )
          )
        )
        if (Result.isFailure(providerResult)) {
          const failure = providerResult.failure
          if (failure._tag === "GovernedActionExecutionStoreError") {
            return yield* failure
          }
          const failedAt = yield* DateTime.now
          const state = yield* store.recordUnknown({
            permitToken: begun.permitToken,
            outcome: failure._tag === "GovernedActionDispatchDeadlineExceeded"
              ? manualUnknown(failedAt, "dispatch-deadline-exceeded")
              : failureUnknown(failure, failedAt)
          })
          return { _tag: "advanced", state } satisfies GovernedActionExecutionResult
        }

        const completedAt = yield* DateTime.now
        const state = yield* store.recordDispatch({
          permitToken: begun.permitToken,
          result: providerResult.success,
          observedAt: completedAt
        })
        return { _tag: "advanced", state } satisfies GovernedActionExecutionResult
      }))
  })

  const reconcile = Effect.fn("GovernedActionExecutionEngine.reconcile")(function*(
    recovery: GovernedActionRecoveryPreparation
  ) {
    return yield* withExecutorForAuthority(
      recovery.scope,
      recovery.runtimeAuthorityToken,
      (lease) =>
        Effect.gen(function*() {
          const executor = Context.get(lease.context, AuthorizedPluginExecutor)
          const remainingMillis = DateTime.toEpochMillis(recovery.reconciliationDeadline) -
            DateTime.toEpochMillis(yield* DateTime.now)
          if (remainingMillis <= 0) return yield* new GovernedActionReconciliationDeadlineExceeded()
          const result = yield* executor.reconcile(recovery.request).pipe(
            Effect.timeoutOrElse({
              duration: remainingMillis,
              orElse: () => Effect.fail(new GovernedActionReconciliationDeadlineExceeded())
            })
          )
          const observedAt = yield* DateTime.now
          const state = yield* store.recordReconciliation({
            recoveryToken: recovery.recoveryToken,
            result,
            observedAt
          })
          return { _tag: "advanced", state } satisfies GovernedActionExecutionResult
        })
    ).pipe(
      Effect.catchTag("PluginRuntimeAuthorityUnavailable", () =>
        DateTime.now.pipe(
          Effect.flatMap((observedAt) =>
            store.recordRecoveryUnavailable({
              recoveryToken: recovery.recoveryToken,
              observedAt,
              reason: "runtime-generation-unavailable"
            })
          ),
          Effect.map((state) => ({ _tag: "advanced", state } satisfies GovernedActionExecutionResult))
        ))
    )
  })

  const run = Effect.fn("GovernedActionExecutionEngine.run")(function*(input: unknown) {
    const reference: GovernedActionExecutionReferenceType = yield* Schema.decodeUnknownEffect(
      Schema.toType(GovernedActionExecutionReference)
    )(input).pipe(Effect.mapError(() => new GovernedActionExecutionInputError()))
    const plan = yield* store.inspect(reference)
    switch (plan._tag) {
      case "inactive":
        return plan satisfies GovernedActionExecutionResult
      case "dispatch":
        return yield* dispatch(plan)
      case "reconcile":
        return yield* reconcile(plan)
    }
  })

  const recoverEligible = Effect.fn("GovernedActionExecutionEngine.recoverEligible")(function*() {
    const references = yield* store.recoveryCandidates
    const results = yield* Effect.forEach(
      references,
      (reference) => run(reference).pipe(Effect.result),
      { concurrency: 1 }
    )
    return {
      attempted: references.length,
      advanced: results.filter(Result.isSuccess).filter(({ success }) => success._tag === "advanced").length,
      inactive: results.filter(Result.isSuccess).filter(({ success }) => success._tag === "inactive").length,
      failed: results.filter(Result.isFailure).length
    } satisfies GovernedActionRecoverySweepResult
  })

  return { recoverEligible, run }
})

/** Internal execution engine service; only private worker composition may consume this tag. */
export interface GovernedActionExecutionEngineService extends Success<typeof makeGovernedActionExecutionEngine> {}

/** State-driven owner of scoped preflight, one-use dispatch, and non-replaying recovery. */
export class GovernedActionExecutionEngine extends Context.Service<
  GovernedActionExecutionEngine,
  GovernedActionExecutionEngineService
>()("@knpkv/control-center/internal/GovernedActionExecutionEngine") {
  static readonly layer = Layer.effect(GovernedActionExecutionEngine, makeGovernedActionExecutionEngine)
}
