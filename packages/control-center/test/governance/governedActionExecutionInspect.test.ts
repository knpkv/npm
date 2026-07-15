import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionPreparationReader } from "../../src/server/governance/internal/execution-store/preparation.js"
import { digestGovernedActionPreparationToken } from "../../src/server/governance/internal/execution-store/tokens.js"
import { GovernedActionExecutionReference } from "../../src/server/governance/internal/GovernedActionExecutionStore.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"
import {
  ACTION_ID,
  AUTHORIZATION_ID,
  AUTHORIZATION_TRANSITION_ID,
  seedGovernedAction,
  WORKSPACE_ID
} from "./fixtures/authorizedGovernedAction.js"

const OTHER_WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-440000000010")

interface PreparationRow {
  readonly actionId: string
  readonly createdAt: string
  readonly envelopeDigest: string
  readonly expiresAt: string
  readonly headTransitionId: string
  readonly tokenDigest: string
  readonly workspaceId: string
}

const reference = Schema.decodeUnknownSync(GovernedActionExecutionReference)({
  workspaceId: WORKSPACE_ID,
  actionId: ACTION_ID
})
const observedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")

const readPreparations = Effect.fn("GovernedActionExecutionInspectTest.readPreparations")(function*() {
  const { sql } = yield* Database
  return yield* sql<PreparationRow>`SELECT
    preparation_token_digest AS tokenDigest, workspace_id AS workspaceId,
    action_id AS actionId, expected_head_transition_id AS headTransitionId,
    expected_envelope_digest AS envelopeDigest, created_at AS createdAt, expires_at AS expiresAt
  FROM governed_action_execution_preparations`
})

const withInspector = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    Crypto.Crypto | Database | GovernedActionRepository | QuarantineRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-governed-action-inspect-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const repository = GovernedActionRepository.layer.pipe(Layer.provideMerge(foundation))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("governed action execution inspection", () => {
  it.effect("returns a closed not-found result without creating preparation state", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const inspector = yield* makeGovernedActionExecutionInspect

      const result = yield* inspector.inspect(reference).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.operation, "inspect")
        assert.strictEqual(result.failure.reason, "not-found")
      }
      assert.lengthOf(yield* readPreparations(), 0)
    })))

  it.effect("persists only a short-lived digest for the exact authorized head", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const { authorization, envelope } = yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect

      const plan = yield* inspector.inspect(reference)

      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch" || authorization === null) return
      assert.deepStrictEqual(plan.scope, {
        workspaceId: envelope.workspaceId,
        pluginConnectionId: envelope.pluginConnectionId
      })
      const { authorizationId, ...request } = plan.request
      assert.strictEqual(authorizationId, AUTHORIZATION_ID)
      assert.deepStrictEqual(request, {
        proposal: envelope.proposal,
        idempotencyKey: envelope.idempotencyKey,
        payloadDigest: envelope.proposal.payloadDigest,
        authorizedAt: authorization.authorizedAt,
        expiresAt: authorization.expiresAt
      })

      const rows = yield* readPreparations()
      assert.lengthOf(rows, 1)
      assert.deepInclude(rows[0], {
        workspaceId: WORKSPACE_ID,
        actionId: ACTION_ID,
        headTransitionId: "01890f6f-6d6a-7cc0-98d2-440000000009",
        envelopeDigest: envelope.envelopeDigest,
        createdAt: "2026-07-15T10:02:00.000Z",
        expiresAt: "2026-07-15T10:02:30.000Z"
      })
      assert.strictEqual(
        rows[0]?.tokenDigest,
        yield* digestGovernedActionPreparationToken(plan.preparationToken)
      )
      assert.notInclude(JSON.stringify(rows), Redacted.value(plan.preparationToken))
    })))

  it.effect("does not resolve a preparation capability outside its workspace", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return
      const reader = yield* makeGovernedActionExecutionPreparationReader
      const tokenDigest = yield* digestGovernedActionPreparationToken(plan.preparationToken)

      const result = yield* reader.read({
        workspaceId: OTHER_WORKSPACE_ID,
        preparationTokenDigest: tokenDigest
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "RecordNotFoundError")
        if (result.failure._tag !== "RecordNotFoundError") return
        assert.strictEqual(result.failure.workspaceId, OTHER_WORKSPACE_ID)
      }
    })))

  it.effect("keeps proposed and expired actions inactive without issuing a capability", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction({ authorized: false })
      const inspector = yield* makeGovernedActionExecutionInspect

      const proposed = yield* inspector.inspect(reference)
      assert.deepStrictEqual(proposed, { _tag: "inactive", state: "proposed" })
      assert.lengthOf(yield* readPreparations(), 0)
    })))

  it.effect("clips preparation expiry to the remaining human authority", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction({ authorizationExpiresAt: "2026-07-15T10:02:05.000Z" })
      const inspector = yield* makeGovernedActionExecutionInspect

      assert.strictEqual((yield* inspector.inspect(reference))._tag, "dispatch")
      assert.strictEqual((yield* readPreparations())[0]?.expiresAt, "2026-07-15T10:02:05.000Z")
    })))

  it.effect("bounds expired cleanup while preserving existing and newly active capabilities", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      const { envelope } = yield* seedGovernedAction()
      const { sql } = yield* Database
      const expiredDigests = Array.from(
        { length: 257 },
        (_, index) => index.toString(16).padStart(64, "0")
      )
      yield* Effect.forEach(expiredDigests, (digest) =>
        sql`INSERT INTO governed_action_execution_preparations (
          preparation_token_digest, workspace_id, action_id,
          expected_head_transition_id, expected_envelope_digest, created_at, expires_at
        ) VALUES (
          ${digest}, ${WORKSPACE_ID}, ${ACTION_ID}, ${AUTHORIZATION_TRANSITION_ID},
          ${envelope.envelopeDigest}, '2026-07-15T10:00:00.000Z', '2026-07-15T10:01:00.000Z'
        )`, { discard: true })
      const existingActiveDigest = "f".repeat(64)
      yield* sql`INSERT INTO governed_action_execution_preparations (
        preparation_token_digest, workspace_id, action_id,
        expected_head_transition_id, expected_envelope_digest, created_at, expires_at
      ) VALUES (
        ${existingActiveDigest}, ${WORKSPACE_ID}, ${ACTION_ID}, ${AUTHORIZATION_TRANSITION_ID},
        ${envelope.envelopeDigest}, '2026-07-15T10:01:30.000Z', '2026-07-15T10:04:00.000Z'
      )`
      const inspector = yield* makeGovernedActionExecutionInspect
      assert.strictEqual((yield* inspector.inspect(reference))._tag, "dispatch")

      const rows = yield* readPreparations()
      assert.lengthOf(rows, 3)
      assert.lengthOf(rows.filter(({ expiresAt }) => expiresAt <= "2026-07-15T10:02:00.000Z"), 1)
      assert.isTrue(rows.some(({ tokenDigest }) => tokenDigest === existingActiveDigest))
      assert.isTrue(rows.some(({ createdAt }) => createdAt === "2026-07-15T10:02:00.000Z"))
    })))

  it.effect("refuses expired authority", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction({ authorizationExpiresAt: "2026-07-15T10:02:00.000Z" })
      const inspector = yield* makeGovernedActionExecutionInspect

      assert.deepStrictEqual(yield* inspector.inspect(reference), {
        _tag: "inactive",
        state: "authorized"
      })
      assert.lengthOf(yield* readPreparations(), 0)
    })))

  it.effect("rolls back malformed reads before quarantining the bounded diagnostic", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const { sql } = yield* Database
      yield* sql`DROP TRIGGER governed_action_authorizations_no_update`
      yield* sql`UPDATE governed_action_authorizations
        SET authorization_json = '{}' WHERE action_id = ${ACTION_ID}`
      const inspector = yield* makeGovernedActionExecutionInspect

      const result = yield* inspector.inspect(reference).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "GovernedActionExecutionStoreError")
        assert.strictEqual(result.failure.operation, "inspect")
        assert.strictEqual(result.failure.reason, "invalid-record")
      }
      assert.lengthOf(yield* readPreparations(), 0)
      const quarantined = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM quarantined_records WHERE record_key = ${AUTHORIZATION_ID}`
      assert.strictEqual(quarantined[0]?.count, 1)
    })))
})
