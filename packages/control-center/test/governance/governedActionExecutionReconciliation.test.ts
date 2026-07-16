import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import type { GovernedActionState } from "../../src/domain/governedAction/index.js"
import { PluginActionReconciliationResultV1 } from "../../src/domain/plugins/actions.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionRecordReconciliation } from "../../src/server/governance/internal/execution-store/record-reconciliation.js"
import { makeGovernedActionExecutionRecordRecoveryUnavailable } from "../../src/server/governance/internal/execution-store/record-recovery-unavailable.js"
import { Database } from "../../src/server/persistence/Database.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import {
  ACTION,
  claimStartedRecovery,
  requestCancellation,
  withBegin,
  WORKSPACE
} from "./fixtures/governedActionExecution.js"

describe("governed action reconciliation outcomes", () => {
  const cases: ReadonlyArray<{
    readonly expectedState: GovernedActionState
    readonly makeInput: (observedAt: string) => unknown
    readonly name: string
  }> = [
    {
      name: "pending",
      expectedState: "started",
      makeInput: (observedAt) => ({ _tag: "pending", checkedAt: observedAt })
    },
    {
      name: "succeeded",
      expectedState: "succeeded",
      makeInput: (observedAt) => ({
        _tag: "succeeded",
        receipt: {
          status: "succeeded",
          providerOperationId: "reconciled-operation-succeeded",
          safeSummary: "Reconciliation confirmed provider completion",
          observedAt
        }
      })
    },
    {
      name: "failed",
      expectedState: "failed",
      makeInput: (observedAt) => ({
        _tag: "failed",
        receipt: {
          status: "failed",
          providerOperationId: "reconciled-operation-failed",
          safeSummary: "Reconciliation confirmed provider failure",
          observedAt
        }
      })
    },
    {
      name: "cancelled",
      expectedState: "cancelled",
      makeInput: (observedAt) => ({
        _tag: "cancelled",
        receipt: {
          status: "cancelled",
          providerOperationId: "reconciled-operation-cancelled",
          safeSummary: "Reconciliation confirmed provider cancellation",
          observedAt
        }
      })
    }
  ]

  for (const fixture of cases) {
    it.effect(`persists and folds a ${fixture.name} reconciliation result exactly once`, () =>
      withBegin(Effect.gen(function*() {
        const recovery = yield* claimStartedRecovery()
        const receivedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
        yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
        const result = Schema.decodeUnknownSync(PluginActionReconciliationResultV1)(
          fixture.makeInput(DateTime.formatIso(receivedAt))
        )
        const recorder = yield* makeGovernedActionExecutionRecordReconciliation

        assert.strictEqual(
          yield* recorder.recordReconciliation({
            recoveryToken: recovery.recoveryToken,
            result,
            observedAt: receivedAt
          }),
          fixture.expectedState
        )
        assert.strictEqual(
          yield* recorder.recordReconciliation({
            recoveryToken: recovery.recoveryToken,
            result,
            observedAt: receivedAt
          }),
          fixture.expectedState
        )
        const { sql } = yield* Database
        const counts = yield* sql<{
          readonly folds: number
          readonly outcomes: number
          readonly resultKind: string
        }>`SELECT
          (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
          (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
          result_kind AS resultKind
        FROM governed_action_provider_outcomes`
        assert.deepStrictEqual(counts[0], {
          folds: 1,
          outcomes: 1,
          resultKind: fixture.name
        })
      })))
  }

  for (const fixture of cases) {
    it.effect(`folds ${fixture.name} after cancellation without losing cancellation intent`, () =>
      withBegin(Effect.gen(function*() {
        const recovery = yield* claimStartedRecovery()
        const cancellationAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -2 })
        yield* TestClock.setTime(DateTime.toEpochMillis(cancellationAt))
        yield* requestCancellation(cancellationAt)
        const receivedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
        yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
        const recorder = yield* makeGovernedActionExecutionRecordReconciliation
        const state = yield* recorder.recordReconciliation({
          recoveryToken: recovery.recoveryToken,
          result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)(
            fixture.makeInput(DateTime.formatIso(receivedAt))
          ),
          observedAt: receivedAt
        })

        assert.strictEqual(
          state,
          fixture.name === "pending" ? "cancel-requested" : fixture.expectedState
        )
        const { sql } = yield* Database
        const counts = yield* sql<{
          readonly cancellationTransitions: number
          readonly folds: number
          readonly outcomes: number
        }>`SELECT
          (SELECT COUNT(*) FROM governed_action_transitions
            WHERE command_tag = 'requestCancellation') AS cancellationTransitions,
          (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
          (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
        assert.deepStrictEqual(counts[0], { cancellationTransitions: 1, folds: 1, outcomes: 1 })
      })))

    it.effect(`handles cancellation requested after a ${fixture.name} reconciliation result`, () =>
      withBegin(Effect.gen(function*() {
        const recovery = yield* claimStartedRecovery()
        const receivedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
        yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
        const recorder = yield* makeGovernedActionExecutionRecordReconciliation
        assert.strictEqual(
          yield* recorder.recordReconciliation({
            recoveryToken: recovery.recoveryToken,
            result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)(
              fixture.makeInput(DateTime.formatIso(receivedAt))
            ),
            observedAt: receivedAt
          }),
          fixture.expectedState
        )

        const cancellation = yield* requestCancellation(receivedAt).pipe(Effect.result)
        if (fixture.name === "pending") {
          assert.isTrue(Result.isSuccess(cancellation))
        } else {
          assert.isTrue(Result.isFailure(cancellation))
          if (Result.isFailure(cancellation)) {
            assert.strictEqual(cancellation.failure._tag, "GovernedActionInputError")
            if (cancellation.failure._tag === "GovernedActionInputError") {
              assert.strictEqual(cancellation.failure.reason, "illegal-transition")
            }
          }
        }
        const actions = yield* GovernedActionRepository
        assert.strictEqual(
          (yield* actions.read({ workspaceId: WORKSPACE, actionId: ACTION })).head.state,
          fixture.name === "pending" ? "cancel-requested" : fixture.expectedState
        )
        const { sql } = yield* Database
        const counts = yield* sql<{
          readonly cancellationTransitions: number
          readonly folds: number
          readonly outcomes: number
        }>`SELECT
          (SELECT COUNT(*) FROM governed_action_transitions
            WHERE command_tag = 'requestCancellation') AS cancellationTransitions,
          (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
          (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
        assert.deepStrictEqual(counts[0], {
          cancellationTransitions: fixture.name === "pending" ? 1 : 0,
          folds: 1,
          outcomes: 1
        })
      })))
  }

  it.effect("serializes concurrent cancellation and terminal reconciliation", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const receivedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const recorder = yield* makeGovernedActionExecutionRecordReconciliation
      const result = Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
        _tag: "succeeded",
        receipt: {
          status: "succeeded",
          providerOperationId: "concurrent-cancellation-reconciliation",
          safeSummary: "Provider completion raced with cancellation",
          observedAt: DateTime.formatIso(receivedAt)
        }
      })
      const [, reconciliation] = yield* Effect.all([
        requestCancellation(receivedAt).pipe(Effect.result),
        recorder.recordReconciliation({
          recoveryToken: recovery.recoveryToken,
          result,
          observedAt: receivedAt
        }).pipe(Effect.result)
      ], { concurrency: "unbounded" })

      assert.isTrue(Result.isSuccess(reconciliation))
      if (Result.isSuccess(reconciliation)) assert.strictEqual(reconciliation.success, "succeeded")
      const actions = yield* GovernedActionRepository
      assert.strictEqual(
        (yield* actions.read({ workspaceId: WORKSPACE, actionId: ACTION })).head.state,
        "succeeded"
      )
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly cancellationTransitions: number
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_transitions
          WHERE command_tag = 'requestCancellation') AS cancellationTransitions,
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.include([0, 1], counts[0]?.cancellationTransitions)
      assert.strictEqual(counts[0]?.folds, 1)
      assert.strictEqual(counts[0]?.outcomes, 1)
    })))

  it.effect("preserves cancellation when runtime recovery becomes unavailable", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const cancellationAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -2 })
      yield* TestClock.setTime(DateTime.toEpochMillis(cancellationAt))
      yield* requestCancellation(cancellationAt)
      const observedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const recorder = yield* makeGovernedActionExecutionRecordRecoveryUnavailable

      assert.strictEqual(
        yield* recorder.recordRecoveryUnavailable({
          recoveryToken: recovery.recoveryToken,
          observedAt,
          reason: "runtime-generation-unavailable"
        }),
        "cancel-requested"
      )
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly cancellationTransitions: number
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_transitions
          WHERE command_tag = 'requestCancellation') AS cancellationTransitions,
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(counts[0], { cancellationTransitions: 1, folds: 1, outcomes: 1 })
    })))

  it.effect("allows cancellation after runtime recovery becomes unavailable", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const observedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const recorder = yield* makeGovernedActionExecutionRecordRecoveryUnavailable

      assert.strictEqual(
        yield* recorder.recordRecoveryUnavailable({
          recoveryToken: recovery.recoveryToken,
          observedAt,
          reason: "runtime-generation-unavailable"
        }),
        "started"
      )
      yield* requestCancellation(observedAt)
      const actions = yield* GovernedActionRepository
      assert.strictEqual(
        (yield* actions.read({ workspaceId: WORKSPACE, actionId: ACTION })).head.state,
        "cancel-requested"
      )
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly cancellationTransitions: number
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_transitions
          WHERE command_tag = 'requestCancellation') AS cancellationTransitions,
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(counts[0], { cancellationTransitions: 1, folds: 1, outcomes: 1 })
    })))

  it.effect("persists runtime-generation unavailability exactly and rejects a changed observation replay", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const observedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const recorder = yield* makeGovernedActionExecutionRecordRecoveryUnavailable

      assert.strictEqual(
        yield* recorder.recordRecoveryUnavailable({
          recoveryToken: recovery.recoveryToken,
          observedAt,
          reason: "runtime-generation-unavailable"
        }),
        "started"
      )
      assert.strictEqual(
        yield* recorder.recordRecoveryUnavailable({
          recoveryToken: recovery.recoveryToken,
          observedAt,
          reason: "runtime-generation-unavailable"
        }),
        "started"
      )
      const changedObservedAt = DateTime.add(observedAt, { seconds: 1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(changedObservedAt))
      const changed = yield* recorder.recordRecoveryUnavailable({
        recoveryToken: recovery.recoveryToken,
        observedAt: changedObservedAt,
        reason: "runtime-generation-unavailable"
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(changed))
      if (Result.isFailure(changed)) assert.strictEqual(changed.failure.reason, "conflict")
      const { sql } = yield* Database
      const rows = yield* sql<{
        readonly observedAt: string
        readonly outcomeJson: string
        readonly resultKind: string
        readonly sourceKind: string
      }>`SELECT
        observed_at AS observedAt,
        outcome_json AS outcomeJson,
        result_kind AS resultKind,
        source_kind AS sourceKind
      FROM governed_action_provider_outcomes`
      assert.lengthOf(rows, 1)
      assert.deepInclude(rows[0], {
        resultKind: "recovery-unavailable",
        sourceKind: "reconciliation"
      })
      const decodeUnavailable = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
        _tag: Schema.String,
        reason: Schema.String,
        schemaVersion: Schema.Number
      })))
      assert.deepStrictEqual(decodeUnavailable(rows[0]?.outcomeJson ?? "{}"), {
        _tag: "recovery-unavailable",
        reason: "runtime-generation-unavailable",
        schemaVersion: 1
      })
      assert.strictEqual(rows[0]?.observedAt, DateTime.formatIso(observedAt))
    })))

  it.effect("folds a parent-format crash-stranded recovery-unavailable outcome after restart", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const observedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_unavailable_fold
        BEFORE INSERT ON governed_action_provider_outcome_folds
        BEGIN
          SELECT RAISE(ABORT, 'injected unavailable fold failure');
        END`
      const beforeRestart = yield* makeGovernedActionExecutionRecordRecoveryUnavailable
      const failed = yield* beforeRestart.recordRecoveryUnavailable({
        recoveryToken: recovery.recoveryToken,
        observedAt,
        reason: "runtime-generation-unavailable"
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      const stranded = yield* sql<{ readonly outcomeJson: string }>`SELECT outcome_json AS outcomeJson
        FROM governed_action_provider_outcomes`
      const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
      assert.deepStrictEqual(decodeJson(stranded[0]?.outcomeJson ?? "{}"), {
        _tag: "recovery-unavailable",
        reason: "runtime-generation-unavailable",
        schemaVersion: 1
      })

      yield* sql`DROP TRIGGER governed_action_test_fail_unavailable_fold`
      const afterRestart = yield* makeGovernedActionExecutionInspect
      assert.deepStrictEqual(yield* afterRestart.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "started"
      })
      const counts = yield* sql<{ readonly folds: number; readonly outcomes: number }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(counts[0], { folds: 1, outcomes: 1 })
    })))

  it.effect("rejects a changed replay for the same recovery claim", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const receivedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const recorder = yield* makeGovernedActionExecutionRecordReconciliation
      const pending = Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
        _tag: "pending",
        checkedAt: DateTime.formatIso(receivedAt)
      })
      yield* recorder.recordReconciliation({
        recoveryToken: recovery.recoveryToken,
        result: pending,
        observedAt: receivedAt
      })
      const changed = yield* recorder.recordReconciliation({
        recoveryToken: recovery.recoveryToken,
        result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
          _tag: "succeeded",
          receipt: {
            status: "succeeded",
            providerOperationId: "changed-reconciliation-replay",
            safeSummary: "Changed replay must not replace durable evidence",
            observedAt: DateTime.formatIso(receivedAt)
          }
        }),
        observedAt: receivedAt
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(changed))
      if (Result.isFailure(changed)) assert.strictEqual(changed.failure.reason, "conflict")
    })))

  it.effect("accepts an outcome at the provider deadline while the claim persistence margin remains", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      yield* TestClock.setTime(DateTime.toEpochMillis(recovery.reconciliationDeadline))
      const recorder = yield* makeGovernedActionExecutionRecordReconciliation
      assert.strictEqual(
        yield* recorder.recordReconciliation({
          recoveryToken: recovery.recoveryToken,
          result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
            _tag: "pending",
            checkedAt: DateTime.formatIso(recovery.reconciliationDeadline)
          }),
          observedAt: recovery.reconciliationDeadline
        }),
        "started"
      )
    })))

  it.effect("rejects an outcome received at the claim lease expiry", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const claimExpiresAt = DateTime.add(recovery.reconciliationDeadline, { seconds: 30 })
      yield* TestClock.setTime(DateTime.toEpochMillis(claimExpiresAt))
      const recorder = yield* makeGovernedActionExecutionRecordReconciliation
      const expired = yield* recorder.recordReconciliation({
        recoveryToken: recovery.recoveryToken,
        result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
          _tag: "pending",
          checkedAt: DateTime.formatIso(claimExpiresAt)
        }),
        observedAt: claimExpiresAt
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(expired))
      if (Result.isFailure(expired)) assert.strictEqual(expired.failure.reason, "conflict")
      const { sql } = yield* Database
      const outcomes = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_provider_outcomes`
      assert.strictEqual(outcomes[0]?.count, 0)
    })))

  it.effect("folds a persisted terminal outcome after cancellation crosses the fold boundary", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const observedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_cancel_race_fold
        BEFORE INSERT ON governed_action_provider_outcome_folds
        BEGIN
          SELECT RAISE(ABORT, 'injected cancellation race fold failure');
        END`
      const recorder = yield* makeGovernedActionExecutionRecordReconciliation
      const failed = yield* recorder.recordReconciliation({
        recoveryToken: recovery.recoveryToken,
        observedAt,
        result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
          _tag: "succeeded",
          receipt: {
            status: "succeeded",
            providerOperationId: "reconciliation-cancel-fold-boundary",
            safeSummary: "Provider completion persisted before cancellation",
            observedAt: DateTime.formatIso(observedAt)
          }
        })
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      const stranded = yield* sql<{
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(stranded[0], { folds: 0, outcomes: 1 })

      yield* sql`DROP TRIGGER governed_action_test_fail_cancel_race_fold`
      yield* requestCancellation(observedAt)
      const inspect = yield* makeGovernedActionExecutionInspect
      assert.deepStrictEqual(yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "succeeded"
      })
      const recovered = yield* sql<{
        readonly cancellationTransitions: number
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_transitions
          WHERE command_tag = 'requestCancellation') AS cancellationTransitions,
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(recovered[0], { cancellationTransitions: 1, folds: 1, outcomes: 1 })
    })))

  it.effect("folds a crash-stranded reconciliation result from persisted data after restart", () =>
    withBegin(Effect.gen(function*() {
      const recovery = yield* claimStartedRecovery()
      const observedAt = DateTime.add(recovery.reconciliationDeadline, { seconds: -1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_reconciliation_fold
        BEFORE INSERT ON governed_action_provider_outcome_folds
        BEGIN
          SELECT RAISE(ABORT, 'injected reconciliation fold failure');
        END`
      const beforeRestart = yield* makeGovernedActionExecutionRecordReconciliation
      const failed = yield* beforeRestart.recordReconciliation({
        recoveryToken: recovery.recoveryToken,
        observedAt,
        result: Schema.decodeUnknownSync(PluginActionReconciliationResultV1)({
          _tag: "succeeded",
          receipt: {
            status: "succeeded",
            providerOperationId: "reconciliation-before-restart",
            safeSummary: "Provider completion persisted before process restart",
            observedAt: DateTime.formatIso(observedAt)
          }
        })
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      yield* sql`DROP TRIGGER governed_action_test_fail_reconciliation_fold`
      const afterRestart = yield* makeGovernedActionExecutionInspect
      assert.deepStrictEqual(yield* afterRestart.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "succeeded"
      })
      const counts = yield* sql<{
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(counts[0], { folds: 1, outcomes: 1 })
    })))
})
