import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import {
  EntityId,
  GovernedActionId,
  GraphNodeId,
  PluginConnectionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { ReadyPluginActionPreflightV1 } from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionBegin } from "../../src/server/governance/internal/execution-store/begin.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { GovernedActionPolicyEvaluator } from "../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { DeliveryGraphRepository } from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
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
