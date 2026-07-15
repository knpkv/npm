import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { GovernedActionEvidenceSet } from "../../src/domain/governedAction/index.js"
import {
  EntityId,
  EvidenceClaimId,
  EvidenceId,
  GraphNodeId,
  PluginConnectionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionCurrentEvidenceReader } from "../../src/server/governance/internal/execution-store/current-evidence.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { DeliveryGraphRepository } from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-460000000001")
const CONNECTION_ID = Schema.decodeUnknownSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-460000000002")
const ENTITY_ID = Schema.decodeUnknownSync(EntityId)("01890f6f-6d6a-7cc0-98d2-460000000003")
const NODE_ID = Schema.decodeUnknownSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-460000000004")
const EVIDENCE_ID = Schema.decodeUnknownSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-460000000005")
const CLAIM_ID = Schema.decodeUnknownSync(EvidenceClaimId)("01890f6f-6d6a-7cc0-98d2-460000000006")
const SUCCESSOR_CLAIM_ID = Schema.decodeUnknownSync(EvidenceClaimId)(
  "01890f6f-6d6a-7cc0-98d2-460000000007"
)
const SOURCE_OBSERVED_AT = "2026-07-15T09:50:00.000Z"
const RECORDED_AT = "2026-07-15T09:55:00.000Z"
const EVALUATED_AT = "2026-07-15T10:00:00.000Z"
const CURRENT_UNTIL = "2026-07-15T10:50:00.000Z"
const VALID_UNTIL = "2026-07-15T12:00:00.000Z"

const evidence = Schema.decodeUnknownSync(GovernedActionEvidenceSet)([{
  workspaceId: WORKSPACE_ID,
  evidenceId: EVIDENCE_ID,
  evidenceClaimIds: [CLAIM_ID],
  observedAt: SOURCE_OBSERVED_AT,
  validUntil: VALID_UNTIL,
  currentUntil: CURRENT_UNTIL,
  evaluatedAt: EVALUATED_AT,
  source: "current",
  validity: "valid"
}])

const sourceRevision = {
  providerId: "jira",
  pluginConnectionId: CONNECTION_ID,
  vendorImmutableId: "PAY-42",
  revision: "jira-revision-7",
  sourceUrl: "https://jira.example/browse/PAY-42",
  firstObservedAt: "2026-07-15T09:45:00.000Z",
  lastObservedAt: SOURCE_OBSERVED_AT,
  synchronizedAt: RECORDED_AT,
  normalizationSchemaVersion: 1
}

const withReader = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Database | DeliveryGraphRepository>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-current-evidence-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const repository = DeliveryGraphRepository.layer.pipe(Layer.provideMerge(foundation))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedFoundation = Effect.fn("GovernedActionCurrentEvidenceTest.seedFoundation")(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${WORKSPACE_ID}, 'Governance', 1, ${RECORDED_AT}, ${RECORDED_AT})`
  yield* sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${CONNECTION_ID}, 'jira', 'Payments Jira',
    1, 1, ${RECORDED_AT}, ${RECORDED_AT}
  )`
  yield* sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
    entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${ENTITY_ID}, ${CONNECTION_ID}, 'jira', 'PAY-42',
    'issue', 1, ${RECORDED_AT}, ${RECORDED_AT}
  )`
  yield* sql`INSERT INTO entity_revisions (
    workspace_id, entity_id, revision, source_revision, normalization_schema_version,
    source_url, first_observed_at, last_observed_at, synchronized_at, created_at
  ) VALUES (
    ${WORKSPACE_ID}, ${ENTITY_ID}, 1, 'jira-revision-7', 1,
    'https://jira.example/browse/PAY-42', '2026-07-15T09:45:00.000Z',
    ${SOURCE_OBSERVED_AT}, ${RECORDED_AT}, ${RECORDED_AT}
  )`
})

const seedEvidence = Effect.fn("GovernedActionCurrentEvidenceTest.seedEvidence")(function*() {
  yield* seedFoundation()
  const repository = yield* DeliveryGraphRepository
  yield* repository.write(WORKSPACE_ID, {
    entityProjections: [],
    nodes: [{
      workspaceId: WORKSPACE_ID,
      nodeId: NODE_ID,
      endpointKind: "issue",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId: ENTITY_ID, entityKind: "issue" }
      },
      createdAt: RECORDED_AT
    }],
    evidenceItems: [{
      workspaceId: WORKSPACE_ID,
      evidenceId: EVIDENCE_ID,
      schemaVersion: 1,
      attribution: {
        _tag: "plugin",
        pluginConnectionId: CONNECTION_ID,
        sourceEntityId: ENTITY_ID,
        sourceEntityRevision: 1
      },
      verifier: { _tag: "system", component: "plugin-sync/v1" },
      observedAt: SOURCE_OBSERVED_AT,
      recordedAt: RECORDED_AT,
      validUntil: VALID_UNTIL,
      freshness: {
        _tag: "current",
        pluginHealth: { _tag: "healthy", checkedAt: "2026-07-15T09:59:00.000Z" },
        provenance: { _tag: "provider", sourceRevision },
        sourceObservedAt: SOURCE_OBSERVED_AT,
        staleAfterSeconds: 3_600,
        synchronizedAt: RECORDED_AT
      },
      retention: {
        classification: "evidence",
        retainUntil: "2026-08-15T09:55:00.000Z",
        legalHold: false
      }
    }],
    evidenceClaims: [{
      workspaceId: WORKSPACE_ID,
      evidenceClaimId: CLAIM_ID,
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

const readAt = (now: string) =>
  Effect.gen(function*() {
    const reader = yield* makeGovernedActionCurrentEvidenceReader
    return yield* reader.read({
      workspaceId: WORKSPACE_ID,
      evidence,
      now: Schema.decodeUnknownSync(UtcTimestamp)(now)
    })
  })

describe("governed action current evidence", () => {
  it.effect("returns the unchanged canonical references when items and claims remain current", () =>
    withReader(Effect.gen(function*() {
      yield* seedEvidence()

      assert.strictEqual(yield* readAt("2026-07-15T10:05:00.000Z"), evidence)
    })))

  it.effect("rejects evidence that became stale after proposal evaluation", () =>
    withReader(Effect.gen(function*() {
      yield* seedEvidence()

      const result = yield* readAt("2026-07-15T10:50:00.001Z").pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "GovernedActionCurrentEvidenceRejected")
        if (result.failure._tag !== "GovernedActionCurrentEvidenceRejected") return
        assert.strictEqual(result.failure.reason, "evidence-not-current")
      }
    })))

  it.effect("rejects a referenced claim after an immutable successor appears", () =>
    withReader(Effect.gen(function*() {
      yield* seedEvidence()
      const repository = yield* DeliveryGraphRepository
      yield* repository.write(WORKSPACE_ID, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [{
          workspaceId: WORKSPACE_ID,
          evidenceClaimId: SUCCESSOR_CLAIM_ID,
          evidenceId: EVIDENCE_ID,
          subjectNodeId: NODE_ID,
          predicate: "status-observed",
          value: { _tag: "state", value: "Done" },
          recordedAt: "2026-07-15T10:01:00.000Z",
          supersedesEvidenceClaimId: CLAIM_ID
        }],
        relationships: []
      })

      const result = yield* readAt("2026-07-15T10:05:00.000Z").pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "GovernedActionCurrentEvidenceRejected")
        if (result.failure._tag !== "GovernedActionCurrentEvidenceRejected") return
        assert.strictEqual(result.failure.reason, "claim-changed")
      }
    })))

  it.effect("rejects corrupt persisted evidence bytes", () =>
    withReader(Effect.gen(function*() {
      yield* seedEvidence()
      const { sql } = yield* Database
      yield* sql`DROP TRIGGER evidence_items_no_update`
      yield* sql`UPDATE evidence_items SET evidence_digest = ${"f".repeat(64)}
        WHERE workspace_id = ${WORKSPACE_ID} AND evidence_id = ${EVIDENCE_ID}`

      const result = yield* readAt("2026-07-15T10:05:00.000Z").pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "PersistedRecordError")
    })))
})
