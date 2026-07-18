import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginActionDispatchResultV1 } from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionRecordDispatch } from "../../src/server/governance/internal/execution-store/record-dispatch.js"
import { makeGovernedActionRecoveryCandidates } from "../../src/server/governance/internal/execution-store/recovery-candidates.js"
import { Database } from "../../src/server/persistence/Database.js"
import {
  ACTION,
  beginAuthorizedDispatch,
  CONNECTION,
  currentRuntime,
  withBegin,
  WORKSPACE
} from "./fixtures/governedActionExecution.js"

const SECONDARY_WORKSPACE = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-440000000099")

describe("governed action recovery claims", () => {
  it.effect("lists an eligible action until one recovery claim is active", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const recoveryEligibleAt = DateTime.add(permitted.leaseExpiresAt, { seconds: 60 })
      yield* TestClock.setTime(DateTime.toEpochMillis(recoveryEligibleAt))
      const candidates = yield* makeGovernedActionRecoveryCandidates(WORKSPACE)

      assert.deepStrictEqual(yield* candidates.recoveryCandidates, [{
        workspaceId: WORKSPACE,
        actionId: ACTION
      }])

      const inspect = yield* makeGovernedActionExecutionInspect
      const recovery = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(recovery._tag, "reconcile")
      assert.deepStrictEqual(yield* candidates.recoveryCandidates, [])
    })))

  it.effect("excludes eligible actions from another workspace", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const recoveryEligibleAt = DateTime.add(permitted.leaseExpiresAt, { seconds: 60 })
      yield* TestClock.setTime(DateTime.toEpochMillis(recoveryEligibleAt))
      const candidates = yield* makeGovernedActionRecoveryCandidates(SECONDARY_WORKSPACE)

      assert.deepStrictEqual(yield* candidates.recoveryCandidates, [])
    })))

  it.effect("issues one expiring idempotency claim and renews only after expiry", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const recoveryEligibleAt = DateTime.add(permitted.leaseExpiresAt, { seconds: 60 })
      yield* TestClock.setTime(DateTime.toEpochMillis(recoveryEligibleAt))
      const inspect = yield* makeGovernedActionExecutionInspect
      const first = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(first._tag, "reconcile")
      if (first._tag !== "reconcile") return yield* Effect.die("expected recovery claim")
      assert.strictEqual(first.runtimeAuthorityToken, currentRuntime.runtimeAuthorityToken)
      assert.deepStrictEqual(first.scope, {
        workspaceId: WORKSPACE,
        pluginConnectionId: CONNECTION
      })
      assert.isNull(first.request.reconciliationKey)
      assert.strictEqual(first.request.idempotencyKey, "governed-action:PAY-42:done:1")
      assert.strictEqual(
        first.request.payloadDigest,
        "9d105db92a91bedd5843dfa620216110041d07e2c6f4300e32a549e7aebadfd8"
      )
      assert.strictEqual(
        DateTime.toEpochMillis(first.reconciliationDeadline),
        DateTime.toEpochMillis(recoveryEligibleAt) + 30_000
      )
      const firstClaimExpiresAt = DateTime.add(first.reconciliationDeadline, { seconds: 30 })

      assert.deepStrictEqual(yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "started"
      })
      yield* TestClock.setTime(DateTime.toEpochMillis(first.reconciliationDeadline))
      assert.deepStrictEqual(yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION }), {
        _tag: "inactive",
        state: "started"
      })
      yield* TestClock.setTime(DateTime.toEpochMillis(firstClaimExpiresAt))
      const second = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(second._tag, "reconcile")
      if (second._tag !== "reconcile") return yield* Effect.die("expected renewed recovery claim")

      const { sql } = yield* Database
      const claims = yield* sql<{
        readonly claimSequence: number
        readonly leaseExpiresAt: string
      }>`SELECT claim_sequence AS claimSequence, lease_expires_at AS leaseExpiresAt
        FROM governed_action_recovery_claims ORDER BY claim_sequence`
      assert.deepStrictEqual(claims, [
        {
          claimSequence: 1,
          leaseExpiresAt: DateTime.formatIso(firstClaimExpiresAt)
        },
        {
          claimSequence: 2,
          leaseExpiresAt: DateTime.formatIso(DateTime.add(second.reconciliationDeadline, { seconds: 30 }))
        }
      ])
    })))

  it.effect("recovers accepted work through its provider reconciliation key", () =>
    withBegin(Effect.gen(function*() {
      const permitted = yield* beginAuthorizedDispatch()
      const receivedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:02.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(receivedAt))
      const dispatch = yield* makeGovernedActionExecutionRecordDispatch
      yield* dispatch.recordDispatch({
        permitToken: permitted.permitToken,
        observedAt: receivedAt,
        result: Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
          _tag: "confirmed",
          receipt: {
            status: "accepted",
            providerOperationId: "provider-operation-for-recovery",
            reconciliationKey: "provider-reconciliation-key",
            safeSummary: "Provider accepted the mutation",
            observedAt: "2026-07-15T10:02:01.000Z"
          }
        })
      })

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(permitted.leaseExpiresAt, { seconds: 60 })))
      const inspect = yield* makeGovernedActionExecutionInspect
      const recovery = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(recovery._tag, "reconcile")
      if (recovery._tag !== "reconcile") return yield* Effect.die("expected provider-key recovery")
      assert.strictEqual(recovery.request.reconciliationKey, "provider-reconciliation-key")
    })))
})
