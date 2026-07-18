import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import type { GovernedActionUnknownOutcome } from "../../src/domain/governedAction/index.js"
import { GovernedActionId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  AuthorizedPluginActionV1,
  PluginActionDispatchResultV1,
  PluginActionPreflightV1,
  PluginActionReconciliationRequestV1,
  PluginActionReconciliationResultV1
} from "../../src/domain/plugins/actions.js"
import {
  GovernedActionPermitToken,
  GovernedActionPreparationToken,
  GovernedActionRecoveryToken
} from "../../src/server/governance/internal/execution-store/tokens.js"
import { GovernedActionExecutionEngine } from "../../src/server/governance/internal/GovernedActionExecutionEngine.js"
import {
  type GovernedActionBeginResult,
  type GovernedActionExecutionPlan,
  type GovernedActionExecutionReference,
  GovernedActionExecutionStore,
  GovernedActionExecutionStoreError,
  type GovernedActionExecutionStoreV1
} from "../../src/server/governance/internal/GovernedActionExecutionStore.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
import {
  AuthorizedPluginExecutorMap,
  PluginRuntimeAuthorityUnavailable
} from "../../src/server/plugins/internal/AuthorizedPluginExecutorMap.js"
import { PluginRuntimeAuthorityToken } from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import type { AuthorizedPluginExecutorV1 } from "../../src/server/plugins/PluginExecutor.js"

const WORKSPACE_ID = "01890f00-0000-7000-8000-000000000501"
const ACTION_ID = "01890f00-0000-7000-8000-000000000502"
const CONNECTION_ID = "01890f00-0000-7000-8000-000000000503"
const SECONDARY_WORKSPACE_ID = "01890f00-0000-7000-8000-000000000504"
const SECONDARY_CONNECTION_ID = "01890f00-0000-7000-8000-000000000505"
const SECONDARY_ACTION_ID = "01890f00-0000-7000-8000-000000000506"
const OBSERVED_AT = "2026-07-15T10:00:00.000Z"
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(WORKSPACE_ID)
const actionId = Schema.decodeUnknownSync(GovernedActionId)(ACTION_ID)
const connectionId = Schema.decodeUnknownSync(PluginConnectionId)(CONNECTION_ID)
const secondaryWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)(SECONDARY_WORKSPACE_ID)
const secondaryConnectionId = Schema.decodeUnknownSync(PluginConnectionId)(SECONDARY_CONNECTION_ID)
const secondaryActionId = Schema.decodeUnknownSync(GovernedActionId)(SECONDARY_ACTION_ID)
const runtimeAuthorityToken = PluginRuntimeAuthorityToken.make(`sha256:${"a".repeat(64)}`)
const rotatedRuntimeAuthorityToken = PluginRuntimeAuthorityToken.make(`sha256:${"b".repeat(64)}`)
const preparationToken = Schema.decodeUnknownSync(GovernedActionPreparationToken)("1".repeat(64))
const permitToken = Schema.decodeUnknownSync(GovernedActionPermitToken)("2".repeat(64))
const recoveryToken = Schema.decodeUnknownSync(GovernedActionRecoveryToken)("3".repeat(64))
const observedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(OBSERVED_AT)
const reconciliationDeadline = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
  "2026-07-15T10:01:00.000Z"
)

const authorizedRequest = Schema.decodeUnknownSync(AuthorizedPluginActionV1)({
  proposal: {
    proposalKey: "proposal:PAY-42:done",
    capabilityVersion: 1,
    request: {
      actionKind: "transition",
      target: { entityType: "issue", vendorImmutableId: "PAY-42" },
      expectedRevision: "7",
      payload: { status: "Done" },
      evidenceIds: ["evidence-1"]
    },
    payloadDigest: "1".repeat(64),
    summary: "Move PAY-42 to Done",
    impact: { level: "medium", summary: "Changes issue workflow state" },
    proposedAt: OBSERVED_AT
  },
  idempotencyKey: "action:PAY-42:done",
  payloadDigest: "1".repeat(64),
  authorizationId: "authorization:PAY-42:done",
  authorizedAt: OBSERVED_AT,
  expiresAt: "2026-07-15T10:10:00.000Z"
})

const readyPreflight = Schema.decodeUnknownSync(PluginActionPreflightV1)({
  _tag: "ready",
  checkedRevision: "7",
  checkedAt: OBSERVED_AT
})

const blockedPreflight = Schema.decodeUnknownSync(PluginActionPreflightV1)({
  _tag: "blocked",
  reasons: ["Target revision changed"],
  checkedAt: OBSERVED_AT
})

const confirmedDispatch = Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
  _tag: "confirmed",
  receipt: {
    providerOperationId: "provider-operation-1",
    status: "succeeded",
    safeSummary: "Transition applied",
    observedAt: OBSERVED_AT
  }
})

const reconciliationRequest = Schema.decodeUnknownSync(PluginActionReconciliationRequestV1)({
  reconciliationKey: null,
  idempotencyKey: "action:PAY-42:done",
  payloadDigest: "1".repeat(64)
})

const pendingReconciliation = Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
  _tag: "pending",
  checkedAt: OBSERVED_AT
})

const dispatchPlan: GovernedActionExecutionPlan = {
  _tag: "dispatch",
  preparationToken,
  scope: { workspaceId, pluginConnectionId: connectionId },
  request: authorizedRequest
}

const permitted: GovernedActionBeginResult = {
  _tag: "permitted",
  permitToken,
  runtimeAuthorityToken,
  dispatchDeadline: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-07-15T10:00:30.000Z"),
  leaseExpiresAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-07-15T10:01:00.000Z"),
  recovery: { strategy: "idempotency", capabilityVersion: 1 },
  scope: { workspaceId, pluginConnectionId: connectionId },
  request: authorizedRequest
}

const makeHarness = Effect.fn("GovernedActionExecutionEngineTest.harness")(function*(options?: {
  readonly plan?: GovernedActionExecutionPlan
  readonly begin?: GovernedActionBeginResult
  readonly preflightBlocked?: boolean
  readonly executeDefect?: boolean
  readonly executeNever?: boolean
  readonly inspectFails?: boolean
  readonly pauseBegin?: boolean
  readonly reconcileDefectOnce?: boolean
  readonly leaseRuntimeAuthorityToken?: PluginRuntimeAuthorityToken
  readonly recoveryCandidates?: ReadonlyArray<GovernedActionExecutionReference>
}) {
  const events = yield* Ref.make<ReadonlyArray<string>>([])
  const unknowns = yield* Ref.make<ReadonlyArray<GovernedActionUnknownOutcome>>([])
  const beginInputs = yield* Ref.make<ReadonlyArray<Parameters<GovernedActionExecutionStoreV1["begin"]>[0]>>([])
  const beginEntered = yield* Deferred.make<void>()
  const releaseBegin = yield* Deferred.make<void>()
  const executeEntered = yield* Deferred.make<void>()
  const reconciliationCalls = yield* Ref.make(0)
  const record = (event: string) => Ref.update(events, (current) => [...current, event])
  const plan = options?.plan ?? dispatchPlan
  const begin = options?.begin ?? permitted
  const leaseRuntimeAuthorityToken = options?.leaseRuntimeAuthorityToken ?? runtimeAuthorityToken

  const store: GovernedActionExecutionStoreV1 = {
    recoveryCandidates: Effect.succeed(options?.recoveryCandidates ?? []),
    inspect: () =>
      record("inspect").pipe(
        Effect.andThen(
          options?.inspectFails === true
            ? Effect.fail(
              new GovernedActionExecutionStoreError({
                operation: "inspect",
                reason: "persistence-unavailable"
              })
            )
            : Effect.succeed(plan)
        )
      ),
    begin: (input) =>
      Ref.update(beginInputs, (current) => [...current, input]).pipe(
        Effect.andThen(record("begin")),
        Effect.andThen(Deferred.succeed(beginEntered, undefined)),
        Effect.andThen(options?.pauseBegin === true ? Deferred.await(releaseBegin) : Effect.void),
        Effect.as(begin)
      ),
    recordBlocked: () => record("blocked").pipe(Effect.as("denied")),
    recordDispatch: () => record("record-dispatch").pipe(Effect.as("succeeded")),
    recordUnknown: ({ outcome }) =>
      Ref.update(unknowns, (current) => [...current, outcome]).pipe(
        Effect.andThen(record("record-unknown")),
        Effect.as("unknown")
      ),
    recordRecoveryUnavailable: () => record("record-recovery-unavailable").pipe(Effect.as("unknown")),
    recordReconciliation: () => record("record-reconciliation").pipe(Effect.as("unknown"))
  }

  const executor: AuthorizedPluginExecutorV1 = {
    preflight: () =>
      record("preflight").pipe(Effect.as(options?.preflightBlocked === true ? blockedPreflight : readyPreflight)),
    executeAuthorizedAction: () =>
      Effect.gen(function*() {
        yield* record("execute")
        yield* Deferred.succeed(executeEntered, undefined)
        if (options?.executeDefect === true) return yield* Effect.die("injected-provider-defect")
        if (options?.executeNever === true) return yield* Effect.never
        return confirmedDispatch
      }),
    requestCancellation: () => Effect.die("cancellation is outside this test"),
    reconcile: (request) =>
      Effect.gen(function*() {
        assert.deepStrictEqual(request, reconciliationRequest)
        yield* record("reconcile")
        const call = yield* Ref.getAndUpdate(reconciliationCalls, (current) => current + 1)
        if (options?.reconcileDefectOnce === true && call === 0) {
          return yield* Effect.die("injected-reconciliation-defect")
        }
        return pendingReconciliation
      })
  }
  const lease = {
    context: Context.make(AuthorizedPluginExecutor, executor),
    runtimeAuthorityToken: leaseRuntimeAuthorityToken
  }
  const executorMap = {
    contextEffect: () => Effect.succeed(lease),
    contextEffectForAuthority: (_scope: unknown, expected: PluginRuntimeAuthorityToken) =>
      expected === lease.runtimeAuthorityToken
        ? Effect.succeed(lease)
        : Effect.fail(new PluginRuntimeAuthorityUnavailable()),
    invalidate: () => Effect.void
  }
  const dependencies = Layer.merge(
    Layer.succeed(GovernedActionExecutionStore, store),
    Layer.succeed(AuthorizedPluginExecutorMap, executorMap)
  )
  return {
    events,
    unknowns,
    beginInputs,
    beginEntered,
    releaseBegin,
    executeEntered,
    layer: GovernedActionExecutionEngine.layer.pipe(Layer.provide(dependencies))
  }
})

const run = (layer: Layer.Layer<GovernedActionExecutionEngine>) =>
  Effect.flatMap(
    GovernedActionExecutionEngine,
    (engine) => engine.run({ workspaceId: WORKSPACE_ID, actionId: ACTION_ID })
  ).pipe(Effect.provide(layer))

const recoverEligible = (layer: Layer.Layer<GovernedActionExecutionEngine>) =>
  Effect.flatMap(
    GovernedActionExecutionEngine,
    (engine) => engine.recoverEligible()
  ).pipe(Effect.provide(layer))

describe("governed action execution engine", () => {
  it.effect("preflights, atomically obtains a new permit, then records the provider receipt", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const harness = yield* makeHarness()
      assert.deepStrictEqual(yield* run(harness.layer), { _tag: "advanced", state: "succeeded" })
      assert.deepStrictEqual(yield* Ref.get(harness.events), [
        "inspect",
        "preflight",
        "begin",
        "execute",
        "record-dispatch"
      ])
    }))

  it.effect("passes the inspected runtime scope to the atomic begin boundary", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const secondaryPlan: GovernedActionExecutionPlan = {
        ...dispatchPlan,
        scope: {
          workspaceId: secondaryWorkspaceId,
          pluginConnectionId: secondaryConnectionId
        }
      }
      const harness = yield* makeHarness({
        plan: secondaryPlan,
        begin: { ...permitted, scope: secondaryPlan.scope }
      })

      assert.deepStrictEqual(yield* run(harness.layer), { _tag: "advanced", state: "succeeded" })
      const [beginInput] = yield* Ref.get(harness.beginInputs)
      assert.deepStrictEqual(beginInput?.scope, secondaryPlan.scope)
    }))

  it.effect("rejects a permit bound to a different runtime scope before dispatch", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const secondaryPlan: GovernedActionExecutionPlan = {
        ...dispatchPlan,
        scope: {
          workspaceId: secondaryWorkspaceId,
          pluginConnectionId: secondaryConnectionId
        }
      }
      const mismatch = yield* makeHarness({ plan: secondaryPlan })

      const exit = yield* run(mismatch.layer).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      assert.notInclude(yield* Ref.get(mismatch.events), "execute")
    }))

  it.effect("does not call the provider when preflight blocks or begin grants no permit", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const blocked = yield* makeHarness({ preflightBlocked: true })
      assert.deepStrictEqual(yield* run(blocked.layer), { _tag: "advanced", state: "denied" })
      assert.deepStrictEqual(yield* Ref.get(blocked.events), ["inspect", "preflight", "blocked"])

      const replay = yield* makeHarness({ begin: { _tag: "inactive", state: "started" } })
      assert.deepStrictEqual(yield* run(replay.layer), { _tag: "inactive", state: "started" })
      assert.deepStrictEqual(yield* Ref.get(replay.events), ["inspect", "preflight", "begin"])
    }))

  it.effect("rejects a permit for a different runtime generation before dispatch", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const mismatch = yield* makeHarness({
        begin: {
          ...permitted,
          runtimeAuthorityToken: rotatedRuntimeAuthorityToken
        }
      })
      const exit = yield* run(mismatch.layer).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.notInclude(yield* Ref.get(mismatch.events), "execute")
    }))

  it.effect("recovers durable started work by idempotency reconciliation without redispatch", () =>
    Effect.gen(function*() {
      const liveLease = yield* makeHarness({ plan: { _tag: "inactive", state: "started" } })
      assert.deepStrictEqual(yield* run(liveLease.layer), { _tag: "inactive", state: "started" })
      assert.deepStrictEqual(yield* Ref.get(liveLease.events), ["inspect"])

      const recovery = yield* makeHarness({
        plan: {
          _tag: "reconcile",
          recoveryToken,
          runtimeAuthorityToken,
          reconciliationDeadline,
          scope: { workspaceId, pluginConnectionId: connectionId },
          request: reconciliationRequest
        }
      })
      assert.deepStrictEqual(yield* run(recovery.layer), { _tag: "advanced", state: "unknown" })
      assert.deepStrictEqual(yield* Ref.get(recovery.events), [
        "inspect",
        "reconcile",
        "record-reconciliation"
      ])
    }))

  it.effect("reconciles the bounded startup batch sequentially without redispatch", () =>
    Effect.gen(function*() {
      const recovery = yield* makeHarness({
        recoveryCandidates: [{ workspaceId, actionId }],
        plan: {
          _tag: "reconcile",
          recoveryToken,
          runtimeAuthorityToken,
          reconciliationDeadline,
          scope: { workspaceId, pluginConnectionId: connectionId },
          request: reconciliationRequest
        }
      })

      assert.deepStrictEqual(yield* recoverEligible(recovery.layer), {
        attempted: 1,
        advanced: 1,
        inactive: 0,
        failed: 0
      })
      assert.deepStrictEqual(yield* Ref.get(recovery.events), [
        "inspect",
        "reconcile",
        "record-reconciliation"
      ])
    }))

  it.effect("continues the bounded startup batch after one candidate fails", () =>
    Effect.gen(function*() {
      const recovery = yield* makeHarness({
        inspectFails: true,
        recoveryCandidates: [
          { workspaceId, actionId },
          { workspaceId, actionId: secondaryActionId }
        ]
      })

      assert.deepStrictEqual(yield* recoverEligible(recovery.layer), {
        attempted: 2,
        advanced: 0,
        inactive: 0,
        failed: 2
      })
      assert.deepStrictEqual(yield* Ref.get(recovery.events), ["inspect", "inspect"])
    }))

  it.effect("continues the bounded startup batch after one provider defect", () =>
    Effect.gen(function*() {
      const recovery = yield* makeHarness({
        reconcileDefectOnce: true,
        recoveryCandidates: [
          { workspaceId, actionId },
          { workspaceId, actionId: secondaryActionId }
        ],
        plan: {
          _tag: "reconcile",
          recoveryToken,
          runtimeAuthorityToken,
          reconciliationDeadline,
          scope: { workspaceId, pluginConnectionId: connectionId },
          request: reconciliationRequest
        }
      })

      assert.deepStrictEqual(yield* recoverEligible(recovery.layer), {
        attempted: 2,
        advanced: 1,
        inactive: 0,
        failed: 1
      })
      assert.deepStrictEqual(yield* Ref.get(recovery.events), [
        "inspect",
        "reconcile",
        "inspect",
        "reconcile",
        "record-reconciliation"
      ])
    }))

  it.effect("does not call reconciliation after the durable recovery deadline", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(reconciliationDeadline))
      const expired = yield* makeHarness({
        plan: {
          _tag: "reconcile",
          recoveryToken,
          runtimeAuthorityToken,
          reconciliationDeadline,
          scope: { workspaceId, pluginConnectionId: connectionId },
          request: reconciliationRequest
        }
      })

      const exit = yield* run(expired.layer).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(yield* Ref.get(expired.events), ["inspect"])
    }))

  it.effect("does not reconcile against a rotated runtime generation", () =>
    Effect.gen(function*() {
      const recovery = yield* makeHarness({
        leaseRuntimeAuthorityToken: rotatedRuntimeAuthorityToken,
        plan: {
          _tag: "reconcile",
          recoveryToken,
          runtimeAuthorityToken,
          reconciliationDeadline,
          scope: { workspaceId, pluginConnectionId: connectionId },
          request: reconciliationRequest
        }
      })
      assert.deepStrictEqual(yield* run(recovery.layer), { _tag: "advanced", state: "unknown" })
      assert.deepStrictEqual(yield* Ref.get(recovery.events), [
        "inspect",
        "record-recovery-unavailable"
      ])
    }))

  it.effect("does not enter the provider after the durable dispatch deadline", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const paused = yield* makeHarness({ pauseBegin: true })
      const fiber = yield* run(paused.layer).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(paused.beginEntered)
      yield* TestClock.setTime(DateTime.toEpochMillis(permitted.dispatchDeadline) + 1)
      yield* Deferred.succeed(paused.releaseBegin, undefined)
      assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "advanced", state: "unknown" })
      assert.deepStrictEqual(yield* Ref.get(paused.events), [
        "inspect",
        "preflight",
        "begin",
        "record-unknown"
      ])
      const unknowns = yield* Ref.get(paused.unknowns)
      assert.lengthOf(unknowns, 1)
      assert.deepInclude(unknowns[0], { _tag: "manual", reason: "dispatch-deadline-exceeded" })
    }))

  it.effect("records unknown when a provider call exceeds its dispatch deadline", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const slow = yield* makeHarness({ executeNever: true })
      const fiber = yield* run(slow.layer).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(slow.executeEntered)
      yield* TestClock.adjust("31 seconds")
      assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "advanced", state: "unknown" })
      assert.deepStrictEqual(yield* Ref.get(slow.events), [
        "inspect",
        "preflight",
        "begin",
        "execute",
        "record-unknown"
      ])
      const unknowns = yield* Ref.get(slow.unknowns)
      assert.lengthOf(unknowns, 1)
      assert.deepInclude(unknowns[0], { _tag: "manual", reason: "dispatch-deadline-exceeded" })
    }))

  it.effect("records interruption exactly once after durable intent", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const interrupted = yield* makeHarness({ executeNever: true })
      const fiber = yield* run(interrupted.layer).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(interrupted.executeEntered)
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(yield* Ref.get(interrupted.events), [
        "inspect",
        "preflight",
        "begin",
        "execute",
        "record-unknown"
      ])
      const unknowns = yield* Ref.get(interrupted.unknowns)
      assert.lengthOf(unknowns, 1)
      assert.deepInclude(unknowns[0], { _tag: "manual", reason: "interrupted-after-intent" })
    }))

  it.effect("records unknown before rethrowing an executor defect after durable intent", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const defective = yield* makeHarness({ executeDefect: true })
      const exit = yield* run(defective.layer).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const defect = Cause.findDefect(exit.cause)
        assert.isTrue(Result.isSuccess(defect))
        if (Result.isSuccess(defect)) assert.strictEqual(defect.success, "injected-provider-defect")
      }
      assert.deepStrictEqual(yield* Ref.get(defective.events), [
        "inspect",
        "preflight",
        "begin",
        "execute",
        "record-unknown"
      ])
      const unknowns = yield* Ref.get(defective.unknowns)
      assert.lengthOf(unknowns, 1)
      assert.deepInclude(unknowns[0], {
        _tag: "manual",
        reason: "provider-defect-after-intent"
      })
    }))
})
