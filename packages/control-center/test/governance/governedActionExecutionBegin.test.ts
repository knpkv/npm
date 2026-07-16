import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { ReadyPluginActionPreflightV1 } from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionBegin } from "../../src/server/governance/internal/execution-store/begin.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { Database } from "../../src/server/persistence/Database.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import { seedGovernedAction } from "./fixtures/authorizedGovernedAction.js"
import {
  ACTION,
  currentRuntime,
  NOW,
  rotatedRuntime,
  runtimeAuthorityLayerFor,
  runtimeWithoutReconciliation,
  seedCurrentInputs,
  withBegin,
  WORKSPACE
} from "./fixtures/governedActionExecution.js"

describe("governed action execution begin", () => {
  it.effect("atomically consumes preparation and returns exactly one durable permit", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const begin = yield* makeGovernedActionExecutionBegin
      const preflight = Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
        _tag: "ready",
        checkedRevision: "1",
        checkedAt: "2026-07-15T10:02:00.000Z"
      })
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight,
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.strictEqual(result._tag, "permitted")
      if (result._tag !== "permitted") return
      assert.isTrue(DateTime.Order(result.dispatchDeadline, result.leaseExpiresAt) < 0)
      const actions = yield* GovernedActionRepository
      assert.strictEqual(
        (yield* actions.read({ workspaceId: WORKSPACE, actionId: ACTION })).head.state,
        "started"
      )
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly leases: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { attempts: 1, leases: 1, preparations: 0 })

      const replay = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight,
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(replay))
      if (Result.isFailure(replay)) {
        assert.strictEqual(replay.failure.reason, "not-found")
      }
      const unchanged = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_attempts`
      assert.strictEqual(unchanged[0]?.count, 1)
    })))

  it.effect("serializes concurrent begins for the same preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const begin = yield* makeGovernedActionExecutionBegin
      const input = {
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }
      const results = yield* Effect.all([
        begin.begin(input).pipe(Effect.result),
        begin.begin(input).pipe(Effect.result)
      ], { concurrency: "unbounded" })

      const permitted = results.filter(Result.isSuccess)
      const rejected = results.filter(Result.isFailure)
      assert.lengthOf(permitted, 1)
      assert.lengthOf(rejected, 1)
      assert.strictEqual(permitted[0]?.success._tag, "permitted")
      assert.include(["conflict", "not-found"], rejected[0]?.failure.reason)

      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly leases: number
        readonly preparations: number
        readonly startTransitions: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT COUNT(*) FROM governed_action_transitions WHERE command_tag = 'start') AS startTransitions`
      assert.deepStrictEqual(counts[0], {
        attempts: 1,
        leases: 1,
        preparations: 0,
        startTransitions: 1
      })
    })))

  it.effect("rolls back the start transition when the execution lease cannot be written", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_execution_lease
        BEFORE INSERT ON governed_action_execution_leases
        BEGIN
          SELECT RAISE(ABORT, 'injected execution lease failure');
        END`
      const begin = yield* makeGovernedActionExecutionBegin
      const input = {
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }
      const failed = yield* begin.begin(input).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      const rolledBack = yield* sql<{
        readonly attempts: number
        readonly leases: number
        readonly preparations: number
        readonly startTransitions: number
        readonly state: string
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT COUNT(*) FROM governed_action_transitions WHERE command_tag = 'start') AS startTransitions,
        (SELECT state FROM governed_actions WHERE action_id = ${ACTION}) AS state`
      assert.deepStrictEqual(rolledBack[0], {
        attempts: 0,
        leases: 0,
        preparations: 1,
        startTransitions: 0,
        state: "authorized"
      })

      yield* sql`DROP TRIGGER governed_action_test_fail_execution_lease`
      const retry = yield* begin.begin(input)
      assert.strictEqual(retry._tag, "permitted")
    })))

  it.effect("rejects a rotated runtime generation without consuming the preparation", () =>
    withBegin(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
        yield* seedGovernedAction()
        yield* seedCurrentInputs()
        const inspect = yield* makeGovernedActionExecutionInspect
        const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
        assert.strictEqual(prepared._tag, "dispatch")
        if (prepared._tag !== "dispatch") return

        const begin = yield* makeGovernedActionExecutionBegin
        const baseInput = {
          preparationToken: prepared.preparationToken,
          preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
            _tag: "ready",
            checkedRevision: "1",
            checkedAt: "2026-07-15T10:02:00.000Z"
          }),
          scope: prepared.scope
        }
        const staleRuntime = yield* begin.begin({
          ...baseInput,
          runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken
        }).pipe(Effect.result)
        const changedEnvelopeAuthority = yield* begin.begin({
          ...baseInput,
          runtimeAuthorityToken: rotatedRuntime.runtimeAuthorityToken
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(staleRuntime))
        assert.isTrue(Result.isFailure(changedEnvelopeAuthority))
        if (Result.isFailure(staleRuntime)) {
          assert.strictEqual(staleRuntime.failure.reason, "authority-changed")
        }
        if (Result.isFailure(changedEnvelopeAuthority)) {
          assert.strictEqual(changedEnvelopeAuthority.failure.reason, "authority-changed")
        }
        const { sql } = yield* Database
        const rows = yield* sql<{
          readonly attempts: number
          readonly leases: number
          readonly preparations: number
          readonly state: string
        }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT state FROM governed_actions WHERE action_id = ${ACTION}) AS state`
        assert.deepStrictEqual(rows[0], {
          attempts: 0,
          leases: 0,
          preparations: 1,
          state: "authorized"
        })
      }),
      runtimeAuthorityLayerFor(rotatedRuntime)
    ))

  it.effect("consumes a preparation exactly at its expiry boundary", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      yield* TestClock.adjust("30 seconds")
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.deepStrictEqual(result, { _tag: "inactive", state: "authorized" })
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly preparations: number
        readonly startTransitions: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT COUNT(*) FROM governed_action_transitions WHERE command_tag = 'start') AS startTransitions`
      assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 0, startTransitions: 0 })
    })))

  it.effect("rejects a session exactly at its idle expiry without consuming the preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET idle_expires_at = ${DateTime.formatIso(NOW)}
        WHERE workspace_id = ${WORKSPACE}`

      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "authority-changed")
      const counts = yield* sql<{
        readonly attempts: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 1 })
    })))

  it.effect("rejects stale preflight evidence without consuming the preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:01:59.999Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 1 })
    })))

  it.effect("rejects a runtime without reconciliation capability and preserves retry state", () =>
    withBegin(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
        yield* seedGovernedAction()
        yield* seedCurrentInputs()
        const inspect = yield* makeGovernedActionExecutionInspect
        const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
        assert.strictEqual(prepared._tag, "dispatch")
        if (prepared._tag !== "dispatch") return

        const begin = yield* makeGovernedActionExecutionBegin
        const result = yield* begin.begin({
          preparationToken: prepared.preparationToken,
          preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
            _tag: "ready",
            checkedRevision: "1",
            checkedAt: "2026-07-15T10:02:00.000Z"
          }),
          runtimeAuthorityToken: runtimeWithoutReconciliation.runtimeAuthorityToken,
          scope: prepared.scope
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
        const { sql } = yield* Database
        const counts = yield* sql<{
          readonly attempts: number
          readonly preparations: number
        }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
        assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 1 })
      }),
      runtimeAuthorityLayerFor(runtimeWithoutReconciliation)
    ))

  it.effect("expires authority and consumes its preparation in the same transaction", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction({ authorizationExpiresAt: "2026-07-15T10:02:05.000Z" })
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      yield* TestClock.setTime(DateTime.toEpochMillis(
        Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:05.000Z")
      ))
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:04.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.deepStrictEqual(result, { _tag: "inactive", state: "expired" })
      const { sql } = yield* Database
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_execution_preparations`
      assert.strictEqual(rows[0]?.count, 0)
    })))

  it.effect("persists current policy denial without retaining a preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET permission = 'release-owner'
        WHERE workspace_id = ${WORKSPACE}`
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.deepStrictEqual(result, { _tag: "inactive", state: "denied" })
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_execution_preparations`
      assert.strictEqual(rows[0]?.count, 0)
    })))

  it.effect("classifies revoked live authority and preserves retry state on rollback", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET revoked_at = '2026-07-15T10:02:00.000Z'
        WHERE workspace_id = ${WORKSPACE}`
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "authority-changed")
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_execution_preparations`
      assert.strictEqual(rows[0]?.count, 1)
    })))
})
