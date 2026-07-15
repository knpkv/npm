import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import type { GovernedActionState } from "../../src/domain/governedAction/index.js"
import { GovernedActionCommandId, GovernedActionUnknownOutcome } from "../../src/domain/governedAction/index.js"
import {
  DomainEventId,
  EntityId,
  GovernedActionId,
  GovernedActionTransitionId,
  GraphNodeId,
  PluginConnectionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import {
  PluginActionDispatchResultV1,
  PluginActionReconciliationResultV1,
  ReadyPluginActionPreflightV1
} from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionBegin } from "../../src/server/governance/internal/execution-store/begin.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionRecordDispatch } from "../../src/server/governance/internal/execution-store/record-dispatch.js"
import { makeGovernedActionExecutionRecordReconciliation } from "../../src/server/governance/internal/execution-store/record-reconciliation.js"
import { makeGovernedActionExecutionRecordRecoveryUnavailable } from "../../src/server/governance/internal/execution-store/record-recovery-unavailable.js"
import { makeGovernedActionExecutionRecordUnknown } from "../../src/server/governance/internal/execution-store/record-unknown.js"
import { issueGovernedActionPermitToken } from "../../src/server/governance/internal/execution-store/tokens.js"
import { GovernedActionPolicyEvaluator } from "../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { DeliveryGraphRepository } from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { GovernedActionCommitInput } from "../../src/server/persistence/repositories/governed-action/contract.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import { mapPersistenceOperation } from "../../src/server/persistence/repositories/internal.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import {
  CurrentPluginRuntimeAuthority,
  PluginRuntimeAuthorityUnavailable
} from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import { PluginRuntimeAuthoritySource } from "../../src/server/plugins/internal/PluginRuntimeAuthoritySource.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"
import {
  ACTION_ID,
  CONNECTION_ID,
  ENTITY_ID,
  seedGovernedAction,
  WORKSPACE_ID
} from "./fixtures/authorizedGovernedAction.js"

const NOW = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
const WORKSPACE = Schema.decodeUnknownSync(WorkspaceId)(WORKSPACE_ID)
const CONNECTION = Schema.decodeUnknownSync(PluginConnectionId)(CONNECTION_ID)
const ENTITY = Schema.decodeUnknownSync(EntityId)(ENTITY_ID)
const ACTION = Schema.decodeUnknownSync(GovernedActionId)(ACTION_ID)
const NODE_ID = Schema.decodeUnknownSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-440000000011")
const EVIDENCE_ID = "01890f6f-6d6a-7cc0-98d2-44000000000c"
const EVIDENCE_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-44000000000d"
const RUNTIME_TOKEN = `sha256:${"a".repeat(64)}`

const currentRuntime = Schema.decodeUnknownSync(CurrentPluginRuntimeAuthority)({
  schemaVersion: 1,
  scope: { workspaceId: WORKSPACE, pluginConnectionId: CONNECTION },
  expected: {
    providerId: "jira",
    connectionRevision: 1,
    descriptorGeneration: 1,
    configuration: { _tag: "absent" },
    descriptorDigest: "b".repeat(64)
  },
  accountDigest: `sha256:${"c".repeat(64)}`,
  activatedAt: "2026-07-15T10:01:30.000Z",
  generation: 1,
  runtimeAuthorityToken: RUNTIME_TOKEN,
  negotiated: {
    descriptor: {
      contractId: "dev.knpkv.control-center.plugin",
      contractVersion: { major: 1, minor: 0, patch: 0 },
      pluginId: "dev.knpkv.jira",
      adapterVersion: { major: 1, minor: 2, patch: 3 },
      displayName: "Jira",
      configurationFields: [],
      capabilities: [
        { capabilityId: "action.execute", supportedVersions: [1], requirement: "required" },
        { capabilityId: "action.reconcile", supportedVersions: [1], requirement: "required" }
      ]
    },
    capabilities: [
      { capabilityId: "action.execute", version: 1 },
      { capabilityId: "action.reconcile", version: 1 }
    ]
  }
})

const runtimeAuthorityLayer = Layer.effect(
  PluginRuntimeAuthoritySource,
  Effect.gen(function*() {
    const database = yield* Database
    return {
      publish: () => Effect.succeed(currentRuntime),
      transactCurrent: (input, use) =>
        input.scope.workspaceId === currentRuntime.scope.workspaceId &&
          input.scope.pluginConnectionId === currentRuntime.scope.pluginConnectionId &&
          input.runtimeAuthorityToken === currentRuntime.runtimeAuthorityToken
          ? database.transaction(use(currentRuntime)).pipe(
            mapPersistenceOperation("governed-action-begin-test.runtime-authority")
          )
          : Effect.fail(new PluginRuntimeAuthorityUnavailable())
    }
  })
)

const withBegin = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    | Crypto.Crypto
    | Database
    | DeliveryGraphRepository
    | GovernedActionPolicyEvaluator
    | GovernedActionRepository
    | PluginRuntimeAuthoritySource
    | QuarantineRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-governed-action-begin-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const actions = GovernedActionRepository.layer.pipe(Layer.provideMerge(foundation))
    const graph = DeliveryGraphRepository.layer.pipe(Layer.provideMerge(foundation))
    const authority = runtimeAuthorityLayer.pipe(Layer.provide(foundation))
    return yield* use.pipe(
      Effect.provide(Layer.mergeAll(
        actions,
        graph,
        authority,
        GovernedActionPolicyEvaluator.layer
      ))
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedCurrentInputs = Effect.fn("GovernedActionExecutionBeginTest.seedCurrentInputs")(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO entity_revisions (
    workspace_id, entity_id, revision, source_revision, normalization_schema_version,
    source_url, first_observed_at, last_observed_at, synchronized_at, created_at
  ) VALUES (
    ${WORKSPACE}, ${ENTITY}, 1, '1', 1,
    'https://jira.example/browse/PAY-42', '2026-07-15T09:45:00.000Z',
    '2026-07-15T09:50:00.000Z', '2026-07-15T09:55:00.000Z', '2026-07-15T09:55:00.000Z'
  )`
  const graph = yield* DeliveryGraphRepository
  yield* graph.write(WORKSPACE, {
    entityProjections: [{
      projection: {
        workspaceId: WORKSPACE,
        entityId: ENTITY,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "issue",
        displayKey: "PAY-42",
        title: "Ship guarded refunds",
        details: {
          _tag: "issue",
          key: "PAY-42",
          status: "In review",
          priority: "High",
          estimatePoints: 5
        }
      },
      recordedAt: "2026-07-15T09:55:00.000Z"
    }],
    nodes: [{
      workspaceId: WORKSPACE,
      nodeId: NODE_ID,
      endpointKind: "issue",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId: ENTITY, entityKind: "issue" }
      },
      createdAt: "2026-07-15T09:55:00.000Z"
    }],
    evidenceItems: [{
      workspaceId: WORKSPACE,
      evidenceId: EVIDENCE_ID,
      schemaVersion: 1,
      attribution: {
        _tag: "plugin",
        pluginConnectionId: CONNECTION,
        sourceEntityId: ENTITY,
        sourceEntityRevision: 1
      },
      verifier: { _tag: "system", component: "plugin-sync/v1" },
      observedAt: "2026-07-15T09:50:00.000Z",
      recordedAt: "2026-07-15T09:55:00.000Z",
      validUntil: "2026-07-15T11:00:00.000Z",
      freshness: {
        _tag: "current",
        pluginHealth: { _tag: "healthy", checkedAt: "2026-07-15T09:59:00.000Z" },
        provenance: {
          _tag: "provider",
          sourceRevision: {
            providerId: "jira",
            pluginConnectionId: CONNECTION,
            vendorImmutableId: "PAY-42",
            revision: "1",
            sourceUrl: "https://jira.example/browse/PAY-42",
            firstObservedAt: "2026-07-15T09:45:00.000Z",
            lastObservedAt: "2026-07-15T09:50:00.000Z",
            synchronizedAt: "2026-07-15T09:55:00.000Z",
            normalizationSchemaVersion: 1
          }
        },
        sourceObservedAt: "2026-07-15T09:50:00.000Z",
        staleAfterSeconds: 2_400,
        synchronizedAt: "2026-07-15T09:55:00.000Z"
      },
      retention: {
        classification: "evidence",
        retainUntil: "2026-08-15T09:55:00.000Z",
        legalHold: false
      }
    }],
    evidenceClaims: [{
      workspaceId: WORKSPACE,
      evidenceClaimId: EVIDENCE_CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      subjectNodeId: NODE_ID,
      predicate: "status-observed",
      value: { _tag: "state", value: "In review" },
      recordedAt: "2026-07-15T09:56:00.000Z",
      supersedesEvidenceClaimId: null
    }],
    relationships: []
  })
})

const beginAuthorizedDispatch = Effect.fn(
  "GovernedActionExecutionBeginTest.beginAuthorizedDispatch"
)(function*() {
  yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
  yield* seedGovernedAction()
  yield* seedCurrentInputs()
  const inspect = yield* makeGovernedActionExecutionInspect
  const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
  assert.strictEqual(prepared._tag, "dispatch")
  if (prepared._tag !== "dispatch") return yield* Effect.die("expected dispatch preparation")
  const begin = yield* makeGovernedActionExecutionBegin
  const permitted = yield* begin.begin({
    preparationToken: prepared.preparationToken,
    preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
      _tag: "ready",
      checkedRevision: "1",
      checkedAt: "2026-07-15T10:02:00.000Z"
    }),
    runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
    scope: prepared.scope
  })
  assert.strictEqual(permitted._tag, "permitted")
  if (permitted._tag !== "permitted") return yield* Effect.die("expected dispatch permit")
  return permitted
})

const requestCancellation = Effect.fn(
  "GovernedActionExecutionBeginTest.requestCancellation"
)(function*(occurredAt: typeof UtcTimestamp.Type) {
  const actions = yield* GovernedActionRepository
  const cryptoService = yield* Crypto.Crypto
  const record = yield* actions.read({ workspaceId: WORKSPACE, actionId: ACTION })
  const input = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
    envelope: record.envelope,
    expectedHeadTransitionId: record.headTransition.transitionId,
    transitionId: GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7),
    commandId: GovernedActionCommandId.make("test:request-cancellation"),
    command: { _tag: "requestCancellation", safeSummary: "Operator requested cancellation" },
    cause: { _tag: "system", component: "governed-action-execution-test" },
    occurredAt,
    causationId: record.envelope.causationId,
    correlationId: record.envelope.correlationId,
    companion: { _tag: "none" },
    auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
  })
  yield* actions.commit(input)
})

const claimStartedRecovery = Effect.fn(
  "GovernedActionExecutionBeginTest.claimStartedRecovery"
)(function*() {
  const permitted = yield* beginAuthorizedDispatch()
  const recoveryEligibleAt = DateTime.add(permitted.leaseExpiresAt, { seconds: 60 })
  yield* TestClock.setTime(DateTime.toEpochMillis(recoveryEligibleAt))
  const inspect = yield* makeGovernedActionExecutionInspect
  const recovery = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
  assert.strictEqual(recovery._tag, "reconcile")
  if (recovery._tag !== "reconcile") return yield* Effect.die("expected recovery claim")
  return recovery
})

const makeMalformedSecondUuidCrypto = Effect.fn(
  "GovernedActionExecutionBeginTest.makeMalformedSecondUuidCrypto"
)(function*() {
  const cryptoService = yield* Crypto.Crypto
  const uuidCalls = yield* Ref.make(0)
  return Crypto.Crypto.of({
    ...cryptoService,
    randomUUIDv7: Ref.getAndUpdate(uuidCalls, (count) => count + 1).pipe(
      Effect.flatMap((call) => call === 0 ? cryptoService.randomUUIDv7 : Effect.succeed("not-a-uuid"))
    )
  })
})

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

describe("governed action recovery claims", () => {
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
        readonly outcomeJson: string
        readonly resultKind: string
        readonly sourceKind: string
      }>`SELECT
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
        observedAt: Schema.String,
        reason: Schema.String,
        schemaVersion: Schema.Number
      })))
      assert.deepStrictEqual(decodeUnavailable(rows[0]?.outcomeJson ?? "{}"), {
        _tag: "recovery-unavailable",
        observedAt: DateTime.formatIso(observedAt),
        reason: "runtime-generation-unavailable",
        schemaVersion: 1
      })
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
