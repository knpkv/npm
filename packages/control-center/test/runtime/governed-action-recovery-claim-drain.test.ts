import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as TestClock from "effect/testing/TestClock"

import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { Database } from "../../src/server/persistence/Database.js"
import { governedActionRecoveryClaimDrainLayer } from "../../src/server/runtime/GovernedActionExecutionStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import {
  ACTION,
  beginAuthorizedDispatch,
  withBegin,
  WORKSPACE
} from "../governance/fixtures/governedActionExecution.js"

const lifecycleLayer = governedActionRecoveryClaimDrainLayer(WORKSPACE).pipe(
  Layer.provideMerge(ServerLifecycle.layer)
)

const withClaim = <Failure>(use: Effect.Effect<void, Failure, Database | ServerLifecycle>) =>
  Effect.gen(function*() {
    const permitted = yield* beginAuthorizedDispatch()
    const recoveryEligibleAt = DateTime.add(permitted.leaseExpiresAt, { seconds: 60 })
    yield* TestClock.setTime(DateTime.toEpochMillis(recoveryEligibleAt))
    const inspect = yield* makeGovernedActionExecutionInspect
    assert.strictEqual(
      (yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION }))._tag,
      "reconcile"
    )
    yield* use
  })

describe("governed action recovery claim drain", () => {
  it.effect("expires the active claim before reporting a successful drain", () =>
    withBegin(
      withClaim(Effect.gen(function*() {
        const lifecycle = yield* ServerLifecycle
        assert.deepStrictEqual(yield* lifecycle.drainWithin("1 second"), { _tag: "Drained" })

        const { sql } = yield* Database
        const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_recovery_claim_expirations`
        assert.strictEqual(rows[0]?.count, 1)
      })).pipe(Effect.provide(lifecycleLayer))
    ))

  it.effect("reports the named hook when durable expiry cannot commit", () =>
    withBegin(
      withClaim(Effect.gen(function*() {
        const { sql } = yield* Database
        yield* sql`CREATE TRIGGER governed_action_test_fail_claim_expiry
        BEFORE INSERT ON governed_action_recovery_claim_expirations
        BEGIN
          SELECT RAISE(ABORT, 'injected claim expiry failure');
        END`
        const lifecycle = yield* ServerLifecycle
        assert.deepStrictEqual(yield* lifecycle.drainWithin("1 second"), {
          _tag: "HooksFailed",
          hookIds: ["governance.recovery-claim-expiry"]
        })
      })).pipe(Effect.provide(lifecycleLayer))
    ))
})
