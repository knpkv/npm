import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import type { GovernedActionState } from "../../src/domain/governedAction/index.js"
import { GovernedActionUnknownOutcome } from "../../src/domain/governedAction/index.js"
import { PluginActionDispatchResultV1 } from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionRecordDispatch } from "../../src/server/governance/internal/execution-store/record-dispatch.js"
import { makeGovernedActionExecutionRecordUnknown } from "../../src/server/governance/internal/execution-store/record-unknown.js"
import { issueGovernedActionPermitToken } from "../../src/server/governance/internal/execution-store/tokens.js"
import { Database } from "../../src/server/persistence/Database.js"
import {
  ACTION,
  beginAuthorizedDispatch,
  makeMalformedSecondUuidCrypto,
  requestCancellation,
  withBegin,
  WORKSPACE
} from "./fixtures/governedActionExecution.js"

describe("governed action dispatch outcomes", () => {
  const persistedOutcomeTag = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ _tag: Schema.String }))
  )
  const cases: ReadonlyArray<{
    readonly expectedState: GovernedActionState
    readonly input: unknown
    readonly name: string
  }> = [
    {
      name: "accepted",
      expectedState: "started",
      input: {
        _tag: "confirmed",
        receipt: {
          status: "accepted",
          providerOperationId: "provider-operation-accepted",
          reconciliationKey: "reconcile-accepted",
          safeSummary: "Provider accepted the work",
          observedAt: "2026-07-15T10:02:01.000Z"
        }
      }
    },
    {
      name: "succeeded",
      expectedState: "succeeded",
      input: {
        _tag: "confirmed",
        receipt: {
          status: "succeeded",
          providerOperationId: "provider-operation-succeeded",
          safeSummary: "Provider completed the work",
          observedAt: "2026-07-15T10:02:01.000Z"
        }
      }
    },
    {
      name: "failed",
      expectedState: "failed",
      input: {
        _tag: "confirmed",
        receipt: {
          status: "failed",
          providerOperationId: "provider-operation-failed",
          safeSummary: "Provider rejected the work",
          observedAt: "2026-07-15T10:02:01.000Z"
        }
      }
    },
    {
      name: "cancelled",
      expectedState: "cancelled",
      input: {
        _tag: "confirmed",
        receipt: {
          status: "cancelled",
          providerOperationId: "provider-operation-cancelled",
          safeSummary: "Provider cancelled the work",
          observedAt: "2026-07-15T10:02:01.000Z"
        }
      }
    },
    {
      name: "unknown",
      expectedState: "unknown",
      input: {
        _tag: "unknown",
        reconciliationKey: "reconcile-unknown",
        safeSummary: "Provider outcome is not yet known",
        observedAt: "2026-07-15T10:02:01.000Z"
      }
    }
  ]

  for (const fixture of cases) {
    it.effect(`records and folds a ${fixture.name} provider result exactly once`, () =>
      withBegin(Effect.gen(function*() {
        const permitted = yield* beginAuthorizedDispatch()
        const receivedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
        yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
        const result = Schema.decodeUnknownSync(PluginActionDispatchResultV1)(fixture.input)
        const dispatch = yield* makeGovernedActionExecutionRecordDispatch

        assert.strictEqual(
          yield* dispatch.recordDispatch({
            permitToken: permitted.permitToken,
            result,
            observedAt: receivedAt
          }),
          fixture.expectedState
        )
        const { sql } = yield* Database
        const rows = yield* sql<{
          readonly audits: number
          readonly commandDigest: string
          readonly folds: number
          readonly outcomeDigest: string
          readonly outcomeJson: string
          readonly outcomes: number
          readonly resultKind: string
        }>`SELECT
          (SELECT COUNT(*) FROM audit_events) AS audits,
          outcome.expected_command_digest AS commandDigest,
          (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
          outcome.outcome_digest AS outcomeDigest,
          outcome.outcome_json AS outcomeJson,
          (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
          outcome.result_kind AS resultKind
        FROM governed_action_provider_outcomes outcome`
        assert.lengthOf(rows, 1)
        assert.deepInclude(rows[0], {
          audits: 4,
          folds: 1,
          outcomes: 1,
          resultKind: fixture.name
        })
        assert.match(rows[0]?.commandDigest ?? "", /^sha256:[0-9a-f]{64}$/u)
        assert.match(rows[0]?.outcomeDigest ?? "", /^[0-9a-f]{64}$/u)
        assert.strictEqual(
          persistedOutcomeTag(rows[0]?.outcomeJson ?? "{}")._tag,
          result._tag
        )

        assert.strictEqual(
          yield* dispatch.recordDispatch({
            permitToken: permitted.permitToken,
            result,
            observedAt: receivedAt
          }),
          fixture.expectedState
        )
        const replayCounts = yield* sql<{
          readonly folds: number
          readonly outcomes: number
          readonly transitions: number
        }>`SELECT
          (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
          (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
          (SELECT COUNT(*) FROM governed_action_transitions) AS transitions`
        assert.deepStrictEqual(replayCounts[0], { folds: 1, outcomes: 1, transitions: 4 })
      })))
  }

  it.effect("rejects a changed result under an already-folded permit", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const receivedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const dispatch = yield* makeGovernedActionExecutionRecordDispatch
      const succeeded = Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
        _tag: "confirmed",
        receipt: {
          status: "succeeded",
          providerOperationId: "provider-operation-succeeded",
          safeSummary: "Provider completed the work",
          observedAt: "2026-07-15T10:02:01.000Z"
        }
      })
      yield* dispatch.recordDispatch({ permitToken: permitted.permitToken, result: succeeded, observedAt: receivedAt })

      const changed = yield* dispatch.recordDispatch({
        permitToken: permitted.permitToken,
        result: Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
          _tag: "confirmed",
          receipt: {
            status: "failed",
            providerOperationId: "provider-operation-failed",
            safeSummary: "Provider rejected the work",
            observedAt: "2026-07-15T10:02:01.000Z"
          }
        }),
        observedAt: receivedAt
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(changed))
      if (Result.isFailure(changed)) assert.strictEqual(changed.failure.reason, "conflict")
    })))

  it.effect("retains an inbox receipt when folding fails and resumes it after restart", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const receivedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const result = Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
        _tag: "confirmed",
        receipt: {
          status: "succeeded",
          providerOperationId: "provider-operation-crash-boundary",
          safeSummary: "Provider completed before the local fold",
          observedAt: "2026-07-15T10:02:01.000Z"
        }
      })
      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_outcome_fold
        BEFORE INSERT ON governed_action_provider_outcome_folds
        BEGIN
          SELECT RAISE(ABORT, 'injected fold failure');
        END`
      const beforeRestart = yield* makeGovernedActionExecutionRecordDispatch

      const failed = yield* beforeRestart.recordDispatch({
        permitToken: permitted.permitToken,
        result,
        observedAt: receivedAt
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      const stranded = yield* sql<{
        readonly folds: number
        readonly outcomes: number
        readonly transitions: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
        (SELECT COUNT(*) FROM governed_action_transitions) AS transitions`
      assert.deepStrictEqual(stranded[0], { folds: 0, outcomes: 1, transitions: 3 })

      yield* sql`DROP TRIGGER governed_action_test_fail_outcome_fold`
      const cancelledAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:03.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(cancelledAt))
      yield* requestCancellation(cancelledAt)
      const afterRestart = yield* makeGovernedActionExecutionInspect
      assert.deepStrictEqual(yield* afterRestart.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "succeeded"
      })
      const recovered = yield* sql<{
        readonly folds: number
        readonly outcomes: number
        readonly transitions: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
        (SELECT COUNT(*) FROM governed_action_transitions) AS transitions`
      assert.deepStrictEqual(recovered[0], { folds: 1, outcomes: 1, transitions: 5 })
    })))

  it.effect("classifies malformed immediate fold identifiers as conflict without losing the inbox receipt", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const receivedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const malformedCrypto = yield* makeMalformedSecondUuidCrypto()
      const dispatch = yield* makeGovernedActionExecutionRecordDispatch.pipe(
        Effect.provideService(Crypto.Crypto, malformedCrypto)
      )
      const result = yield* dispatch.recordDispatch({
        permitToken: permitted.permitToken,
        observedAt: receivedAt,
        result: Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
          _tag: "confirmed",
          receipt: {
            status: "succeeded",
            providerOperationId: "provider-operation-malformed-fold",
            safeSummary: "Provider completed before malformed local fold data",
            observedAt: "2026-07-15T10:02:01.000Z"
          }
        })
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.operation, "record-dispatch")
        assert.strictEqual(result.failure.reason, "conflict")
      }
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(counts[0], { folds: 0, outcomes: 1 })
    })))

  const cancellationCases: ReadonlyArray<{
    readonly expectedState: GovernedActionState
    readonly input: unknown
    readonly name: string
  }> = [
    {
      name: "accepted",
      expectedState: "cancel-requested",
      input: {
        _tag: "confirmed",
        receipt: {
          status: "accepted",
          providerOperationId: "provider-operation-after-cancel",
          reconciliationKey: "reconcile-after-cancel",
          safeSummary: "Provider accepted before cancellation completed",
          observedAt: "2026-07-15T10:02:02.000Z"
        }
      }
    },
    {
      name: "terminal",
      expectedState: "succeeded",
      input: {
        _tag: "confirmed",
        receipt: {
          status: "succeeded",
          providerOperationId: "provider-operation-won-cancel-race",
          safeSummary: "Provider completed before cancellation",
          observedAt: "2026-07-15T10:02:02.000Z"
        }
      }
    },
    {
      name: "unknown",
      expectedState: "cancel-requested-unknown",
      input: {
        _tag: "unknown",
        reconciliationKey: "reconcile-cancel-race",
        safeSummary: "Cancellation race needs reconciliation",
        observedAt: "2026-07-15T10:02:02.000Z"
      }
    }
  ]

  for (const fixture of cancellationCases) {
    it.effect(`folds a ${fixture.name} result without losing cancellation intent`, () =>
      withBegin(Effect.gen(function*() {
        const permitted = yield* beginAuthorizedDispatch()
        const cancelledAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:01.000Z")
        yield* TestClock.setTime(DateTime.toEpochMillis(cancelledAt))
        yield* requestCancellation(cancelledAt)
        const receivedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:03.000Z")
        yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
        const dispatch = yield* makeGovernedActionExecutionRecordDispatch

        assert.strictEqual(
          yield* dispatch.recordDispatch({
            permitToken: permitted.permitToken,
            result: Schema.decodeUnknownSync(PluginActionDispatchResultV1)(fixture.input),
            observedAt: receivedAt
          }),
          fixture.expectedState
        )
      })))
  }

  it.effect("rejects deadline and lease boundary observations without creating an inbox row", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      yield* TestClock.setTime(DateTime.toEpochMillis(permitted.leaseExpiresAt))
      const dispatch = yield* makeGovernedActionExecutionRecordDispatch
      const atDeadline = Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
        _tag: "unknown",
        reconciliationKey: "reconcile-too-late",
        safeSummary: "Result arrived too late",
        observedAt: DateTime.formatIso(permitted.dispatchDeadline)
      })

      const result = yield* dispatch.recordDispatch({
        permitToken: permitted.permitToken,
        result: atDeadline,
        observedAt: permitted.leaseExpiresAt
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
      const { sql } = yield* Database
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_provider_outcomes`
      assert.strictEqual(rows[0]?.count, 0)
    })))

  it.effect("returns not-found for a permit that was never issued", () =>
    withBegin(Effect.gen(function*() {
      const issued = yield* issueGovernedActionPermitToken()
      const dispatch = yield* makeGovernedActionExecutionRecordDispatch
      const result = yield* dispatch.recordDispatch({
        permitToken: issued.token,
        result: Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
          _tag: "unknown",
          reconciliationKey: "reconcile-missing-permit",
          safeSummary: "No matching execution",
          observedAt: "2026-07-15T10:02:01.000Z"
        }),
        observedAt: Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "not-found")
    })))
})

describe("governed action local unknown outcomes", () => {
  it.effect("records manual uncertainty after the dispatch deadline and replays it exactly", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const observedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:20.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const recorder = yield* makeGovernedActionExecutionRecordUnknown
      const outcome = Schema.decodeUnknownSync(GovernedActionUnknownOutcome)({
        _tag: "manual",
        observedAt: "2026-07-15T10:02:20.000Z",
        safeSummary: "Dispatch crossed the provider intent boundary",
        reason: "interrupted-after-intent"
      })

      assert.strictEqual(
        yield* recorder.recordUnknown({ permitToken: permitted.permitToken, outcome }),
        "unknown"
      )
      assert.strictEqual(
        yield* recorder.recordUnknown({ permitToken: permitted.permitToken, outcome }),
        "unknown"
      )

      const changed = yield* recorder.recordUnknown({
        permitToken: permitted.permitToken,
        outcome: Schema.decodeUnknownSync(GovernedActionUnknownOutcome)({
          _tag: "manual",
          observedAt: "2026-07-15T10:02:20.000Z",
          safeSummary: "A different report for the same permit",
          reason: "interrupted-after-intent"
        })
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(changed))
      if (Result.isFailure(changed)) assert.strictEqual(changed.failure.reason, "conflict")

      const { sql } = yield* Database
      const rows = yield* sql<{
        readonly folds: number
        readonly outcomes: number
        readonly resultKind: string
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
        outcome.result_kind AS resultKind
      FROM governed_action_provider_outcomes outcome`
      assert.deepStrictEqual(rows[0], { folds: 1, outcomes: 1, resultKind: "manual-unknown" })
    })))

  it.effect("keeps reconcilable uncertainty inside the provider dispatch window", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const receivedAt = DateTime.add(permitted.dispatchDeadline, { seconds: 1 })
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const recorder = yield* makeGovernedActionExecutionRecordUnknown
      const result = yield* recorder.recordUnknown({
        permitToken: permitted.permitToken,
        outcome: Schema.decodeUnknownSync(GovernedActionUnknownOutcome)({
          _tag: "reconcilable",
          reconciliationKey: "reconcile-at-deadline",
          observedAt: DateTime.formatIso(permitted.dispatchDeadline),
          safeSummary: "Provider result arrived at the closed deadline"
        })
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
      const { sql } = yield* Database
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_provider_outcomes`
      assert.strictEqual(rows[0]?.count, 0)
    })))

  it.effect("preserves cancellation intent when recording a local unknown", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const cancelledAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:01.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(cancelledAt))
      yield* requestCancellation(cancelledAt)
      const observedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const recorder = yield* makeGovernedActionExecutionRecordUnknown

      assert.strictEqual(
        yield* recorder.recordUnknown({
          permitToken: permitted.permitToken,
          outcome: Schema.decodeUnknownSync(GovernedActionUnknownOutcome)({
            _tag: "reconcilable",
            reconciliationKey: "reconcile-cancelled-local",
            observedAt: "2026-07-15T10:02:02.000Z",
            safeSummary: "Cancellation raced with provider intent"
          })
        }),
        "cancel-requested-unknown"
      )
    })))

  it.effect("folds a crash-stranded local unknown from persisted data after restart", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const observedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_local_unknown_fold
        BEFORE INSERT ON governed_action_provider_outcome_folds
        BEGIN
          SELECT RAISE(ABORT, 'injected local unknown fold failure');
        END`
      const beforeRestart = yield* makeGovernedActionExecutionRecordUnknown
      const failed = yield* beforeRestart.recordUnknown({
        permitToken: permitted.permitToken,
        outcome: Schema.decodeUnknownSync(GovernedActionUnknownOutcome)({
          _tag: "reconcilable",
          reconciliationKey: "reconcile-local-restart",
          observedAt: "2026-07-15T10:02:02.000Z",
          safeSummary: "Outcome persisted before the process stopped"
        })
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      yield* sql`DROP TRIGGER governed_action_test_fail_local_unknown_fold`

      const afterRestart = yield* makeGovernedActionExecutionInspect
      assert.deepStrictEqual(yield* afterRestart.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "unknown"
      })
      const rows = yield* sql<{
        readonly folds: number
        readonly outcomes: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_provider_outcome_folds) AS folds,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes`
      assert.deepStrictEqual(rows[0], { folds: 1, outcomes: 1 })
    })))
})
