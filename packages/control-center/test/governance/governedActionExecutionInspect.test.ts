import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { GovernedActionCommandId } from "../../src/domain/governedAction/index.js"
import {
  DomainEventId,
  GovernedActionTransitionId,
  PluginConnectionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { BlockedPluginActionPreflightV1 } from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionPreparationReader } from "../../src/server/governance/internal/execution-store/preparation.js"
import { makeGovernedActionExecutionRecordBlocked } from "../../src/server/governance/internal/execution-store/record-blocked.js"
import { digestGovernedActionPreparationToken } from "../../src/server/governance/internal/execution-store/tokens.js"
import { GovernedActionExecutionReference } from "../../src/server/governance/internal/GovernedActionExecutionStore.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { GovernedActionCommitInput } from "../../src/server/persistence/repositories/governed-action/contract.js"
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
const OTHER_CONNECTION_ID = Schema.decodeUnknownSync(PluginConnectionId)(
  "01890f6f-6d6a-7cc0-98d2-440000000012"
)

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

describe("governed action blocked preflight", () => {
  const blockedAt = Schema.decodeUnknownSync(BlockedPluginActionPreflightV1)({
    _tag: "blocked",
    reasons: ["Target revision is no longer deployable", "Required approval is missing"],
    checkedAt: "2026-07-15T10:02:00.000Z"
  })

  it.effect("denies the exact prepared action and consumes the capability atomically", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return

      const blocked = yield* makeGovernedActionExecutionRecordBlocked
      assert.strictEqual(
        yield* blocked.recordBlocked({
          preparationToken: plan.preparationToken,
          preflight: blockedAt,
          observedAt,
          scope: plan.scope
        }),
        "denied"
      )

      const actions = yield* GovernedActionRepository
      const record = yield* actions.read(reference)
      assert.strictEqual(record.head.state, "denied")
      assert.deepStrictEqual(record.headTransition.command, {
        _tag: "deny",
        reason: "preflight-blocked",
        safeSummary: "Target revision is no longer deployable (+1 more)"
      })
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly audits: number
        readonly outcomes: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM audit_events WHERE event_kind = 'denied') AS audits,
        (SELECT COUNT(*) FROM governed_action_provider_outcomes) AS outcomes,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { audits: 1, outcomes: 0, preparations: 0 })

      const replay = yield* blocked.recordBlocked({
        preparationToken: plan.preparationToken,
        preflight: blockedAt,
        observedAt,
        scope: plan.scope
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(replay))
      if (Result.isFailure(replay)) assert.strictEqual(replay.failure.reason, "not-found")
    })))

  it.effect("rejects a cross-wired plugin connection without consuming the preparation", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return
      const blocked = yield* makeGovernedActionExecutionRecordBlocked

      const result = yield* blocked.recordBlocked({
        preparationToken: plan.preparationToken,
        preflight: blockedAt,
        observedAt,
        scope: { workspaceId: plan.scope.workspaceId, pluginConnectionId: OTHER_CONNECTION_ID }
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
      assert.lengthOf(yield* readPreparations(), 1)
    })))

  it.effect("authenticates scope and timestamps before consuming an inactive preparation", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return
      const actions = yield* GovernedActionRepository
      const cryptoService = yield* Crypto.Crypto
      const record = yield* actions.read(reference)
      const cancelled = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
        envelope: record.envelope,
        expectedHeadTransitionId: record.headTransition.transitionId,
        transitionId: GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7),
        commandId: GovernedActionCommandId.make("test:cancel-prepared-action"),
        command: { _tag: "cancel", safeSummary: "Operator cancelled before dispatch" },
        cause: { _tag: "system", component: "governed-action-execution-test" },
        occurredAt: observedAt,
        causationId: record.envelope.causationId,
        correlationId: record.envelope.correlationId,
        companion: { _tag: "none" },
        auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
      })
      yield* actions.commit(cancelled)
      const blocked = yield* makeGovernedActionExecutionRecordBlocked

      const crossWired = yield* blocked.recordBlocked({
        preparationToken: plan.preparationToken,
        preflight: blockedAt,
        observedAt,
        scope: { workspaceId: plan.scope.workspaceId, pluginConnectionId: OTHER_CONNECTION_ID }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossWired))
      if (Result.isFailure(crossWired)) assert.strictEqual(crossWired.failure.reason, "conflict")
      assert.lengthOf(yield* readPreparations(), 1)

      const impossibleTime = yield* blocked.recordBlocked({
        preparationToken: plan.preparationToken,
        preflight: Schema.decodeUnknownSync(BlockedPluginActionPreflightV1)({
          _tag: "blocked",
          reasons: ["Impossible future preflight"],
          checkedAt: "2026-07-15T10:02:01.000Z"
        }),
        observedAt,
        scope: plan.scope
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(impossibleTime))
      if (Result.isFailure(impossibleTime)) assert.strictEqual(impossibleTime.failure.reason, "conflict")
      assert.lengthOf(yield* readPreparations(), 1)

      assert.strictEqual(
        yield* blocked.recordBlocked({
          preparationToken: plan.preparationToken,
          preflight: blockedAt,
          observedAt,
          scope: plan.scope
        }),
        "cancelled"
      )
      assert.lengthOf(yield* readPreparations(), 0)
    })))

  it.effect("rejects impossible provider timestamps without consuming the preparation", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return
      const blocked = yield* makeGovernedActionExecutionRecordBlocked
      const futurePreflight = Schema.decodeUnknownSync(BlockedPluginActionPreflightV1)({
        _tag: "blocked",
        reasons: ["Future observation"],
        checkedAt: "2026-07-15T10:02:01.000Z"
      })

      const result = yield* blocked.recordBlocked({
        preparationToken: plan.preparationToken,
        preflight: futurePreflight,
        observedAt,
        scope: plan.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
      assert.lengthOf(yield* readPreparations(), 1)
    })))

  it.effect("expires elapsed human authority instead of recording a preflight denial", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction({ authorizationExpiresAt: "2026-07-15T10:02:05.000Z" })
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return
      const elapsedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:05.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(elapsedAt))
      const blocked = yield* makeGovernedActionExecutionRecordBlocked

      assert.strictEqual(
        yield* blocked.recordBlocked({
          preparationToken: plan.preparationToken,
          preflight: Schema.decodeUnknownSync(BlockedPluginActionPreflightV1)({
            _tag: "blocked",
            reasons: ["Provider is unavailable"],
            checkedAt: "2026-07-15T10:02:05.000Z"
          }),
          observedAt: elapsedAt,
          scope: plan.scope
        }),
        "expired"
      )
      assert.strictEqual((yield* (yield* GovernedActionRepository).read(reference)).head.state, "expired")
      assert.lengthOf(yield* readPreparations(), 0)
    })))

  it.effect("consumes an elapsed preparation without changing still-live authority", () =>
    withInspector(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(observedAt))
      yield* seedGovernedAction()
      const inspector = yield* makeGovernedActionExecutionInspect
      const plan = yield* inspector.inspect(reference)
      assert.strictEqual(plan._tag, "dispatch")
      if (plan._tag !== "dispatch") return
      const elapsedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:30.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(elapsedAt))
      const blocked = yield* makeGovernedActionExecutionRecordBlocked

      assert.strictEqual(
        yield* blocked.recordBlocked({
          preparationToken: plan.preparationToken,
          preflight: Schema.decodeUnknownSync(BlockedPluginActionPreflightV1)({
            _tag: "blocked",
            reasons: ["Provider is unavailable"],
            checkedAt: "2026-07-15T10:02:30.000Z"
          }),
          observedAt: elapsedAt,
          scope: plan.scope
        }),
        "authorized"
      )
      assert.strictEqual((yield* (yield* GovernedActionRepository).read(reference)).head.state, "authorized")
      assert.lengthOf(yield* readPreparations(), 0)
    })))
})
