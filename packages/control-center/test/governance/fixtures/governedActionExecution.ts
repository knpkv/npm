import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { GovernedActionCommandId } from "../../../src/domain/governedAction/index.js"
import {
  DomainEventId,
  EntityId,
  GovernedActionId,
  GovernedActionTransitionId,
  GraphNodeId,
  PluginConnectionId,
  WorkspaceId
} from "../../../src/domain/identifiers.js"
import { ReadyPluginActionPreflightV1 } from "../../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionBegin } from "../../../src/server/governance/internal/execution-store/begin.js"
import { makeGovernedActionExecutionInspect } from "../../../src/server/governance/internal/execution-store/inspect.js"
import { GovernedActionPolicyEvaluator } from "../../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database, databaseLayer } from "../../../src/server/persistence/Database.js"
import { DeliveryGraphRepository } from "../../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { GovernedActionCommitInput } from "../../../src/server/persistence/repositories/governed-action/contract.js"
import { GovernedActionRepository } from "../../../src/server/persistence/repositories/governedActionRepository.js"
import { mapPersistenceOperation } from "../../../src/server/persistence/repositories/internal.js"
import { QuarantineRepository } from "../../../src/server/persistence/repositories/quarantineRepository.js"
import {
  CurrentPluginRuntimeAuthority,
  PluginRuntimeAuthorityUnavailable
} from "../../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import { PluginRuntimeAuthoritySource } from "../../../src/server/plugins/internal/PluginRuntimeAuthoritySource.js"
import { makePersistenceTestConfig } from "../../persistence/fixtures.js"
import { ACTION_ID, CONNECTION_ID, ENTITY_ID, seedGovernedAction, WORKSPACE_ID } from "./authorizedGovernedAction.js"

export const NOW = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
export const WORKSPACE = Schema.decodeUnknownSync(WorkspaceId)(WORKSPACE_ID)
export const CONNECTION = Schema.decodeUnknownSync(PluginConnectionId)(CONNECTION_ID)
const ENTITY = Schema.decodeUnknownSync(EntityId)(ENTITY_ID)
export const ACTION = Schema.decodeUnknownSync(GovernedActionId)(ACTION_ID)
const NODE_ID = Schema.decodeUnknownSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-440000000011")
const EVIDENCE_ID = "01890f6f-6d6a-7cc0-98d2-44000000000c"
const EVIDENCE_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-44000000000d"
const RUNTIME_TOKEN = `sha256:${"a".repeat(64)}`

export const currentRuntime = Schema.decodeUnknownSync(CurrentPluginRuntimeAuthority)({
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

export const rotatedRuntime = Schema.decodeUnknownSync(CurrentPluginRuntimeAuthority)({
  ...Schema.encodeSync(CurrentPluginRuntimeAuthority)(currentRuntime),
  activatedAt: "2026-07-15T10:01:45.000Z",
  generation: 2,
  runtimeAuthorityToken: `sha256:${"d".repeat(64)}`
})
const encodedCurrentRuntime = Schema.encodeSync(CurrentPluginRuntimeAuthority)(currentRuntime)
export const runtimeWithoutReconciliation = Schema.decodeUnknownSync(CurrentPluginRuntimeAuthority)({
  ...encodedCurrentRuntime,
  negotiated: {
    descriptor: encodedCurrentRuntime.negotiated.descriptor,
    capabilities: encodedCurrentRuntime.negotiated.capabilities.filter(
      ({ capabilityId }) => capabilityId !== "action.reconcile"
    )
  }
})

export const runtimeAuthorityLayerFor = (runtime: typeof currentRuntime) =>
  Layer.effect(
    PluginRuntimeAuthoritySource,
    Effect.gen(function*() {
      const database = yield* Database
      return {
        publish: () => Effect.succeed(runtime),
        transactCurrent: (input, use) =>
          input.scope.workspaceId === runtime.scope.workspaceId &&
            input.scope.pluginConnectionId === runtime.scope.pluginConnectionId &&
            input.runtimeAuthorityToken === runtime.runtimeAuthorityToken
            ? database.transaction(use(runtime)).pipe(
              mapPersistenceOperation("governed-action-begin-test.runtime-authority")
            )
            : Effect.fail(new PluginRuntimeAuthorityUnavailable())
      }
    })
  )
const runtimeAuthorityLayer = runtimeAuthorityLayerFor(currentRuntime)

export const withBegin = <Success, Failure>(
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
  >,
  authorityLayer = runtimeAuthorityLayer
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-governed-action-begin-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const actions = GovernedActionRepository.layer.pipe(Layer.provideMerge(foundation))
    const graph = DeliveryGraphRepository.layer.pipe(Layer.provideMerge(foundation))
    const authority = authorityLayer.pipe(Layer.provide(foundation))
    return yield* use.pipe(
      Effect.provide(Layer.mergeAll(
        actions,
        graph,
        authority,
        GovernedActionPolicyEvaluator.layer
      ))
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

export const seedCurrentInputs = Effect.fn("GovernedActionExecutionBeginTest.seedCurrentInputs")(function*() {
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

export const beginAuthorizedDispatch = Effect.fn(
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

export const requestCancellation = Effect.fn(
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

export const claimStartedRecovery = Effect.fn(
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

export const makeMalformedSecondUuidCrypto = Effect.fn(
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
