import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { EntityId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { makeGovernedActionCurrentTargetReader } from "../../src/server/governance/internal/execution-store/current-target.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { DeliveryGraphRepository } from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-450000000001")
const CONNECTION_ID = Schema.decodeUnknownSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-450000000002")
const ENTITY_ID = Schema.decodeUnknownSync(EntityId)("01890f6f-6d6a-7cc0-98d2-450000000003")
const OTHER_WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)(
  "01890f6f-6d6a-7cc0-98d2-450000000004"
)
const RECORDED_AT = "2026-07-15T10:00:00.000Z"

const withReader = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Database | DeliveryGraphRepository>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-current-target-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const repository = DeliveryGraphRepository.layer.pipe(Layer.provideMerge(foundation))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedEntity = Effect.fn("GovernedActionCurrentTargetTest.seedEntity")(function*() {
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
    'https://jira.example/browse/PAY-42', '2026-07-15T09:55:00.000Z',
    '2026-07-15T09:58:00.000Z', ${RECORDED_AT}, ${RECORDED_AT}
  )`
})

const writeProjection = Effect.fn("GovernedActionCurrentTargetTest.writeProjection")(function*(input?: {
  readonly entityState?: "present" | "deleted"
  readonly projectionRevision?: number
  readonly sourceEntityRevision?: number
  readonly supersedesProjectionRevision?: number | null
}) {
  const repository = yield* DeliveryGraphRepository
  const projectionRevision = input?.projectionRevision ?? 1
  yield* repository.write(WORKSPACE_ID, {
    entityProjections: [{
      projection: {
        workspaceId: WORKSPACE_ID,
        entityId: ENTITY_ID,
        projectionRevision,
        sourceEntityRevision: input?.sourceEntityRevision ?? 1,
        supersedesProjectionRevision: input?.supersedesProjectionRevision ?? null,
        projectionSchemaVersion: 1,
        entityState: input?.entityState ?? "present",
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
      recordedAt: RECORDED_AT
    }],
    nodes: [],
    evidenceItems: [],
    evidenceClaims: [],
    relationships: []
  })
})

const readCurrent = Effect.gen(function*() {
  const reader = yield* makeGovernedActionCurrentTargetReader
  return yield* reader.read({ workspaceId: WORKSPACE_ID, entityId: ENTITY_ID })
})

describe("governed action current target", () => {
  it.effect("returns the exact current normalized target and provider provenance", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()

      const target = yield* readCurrent
      assert.strictEqual(target.workspaceId, WORKSPACE_ID)
      assert.strictEqual(target.entityId, ENTITY_ID)
      assert.strictEqual(target.entityType, "issue")
      assert.strictEqual(target.sourceRevision.providerId, "jira")
      assert.strictEqual(target.sourceRevision.pluginConnectionId, CONNECTION_ID)
      assert.strictEqual(target.sourceRevision.vendorImmutableId, "PAY-42")
      assert.strictEqual(target.sourceRevision.revision, "jira-revision-7")
      assert.strictEqual(target.sourceRevision.sourceUrl?.href, "https://jira.example/browse/PAY-42")
      assert.strictEqual(target.sourceRevision.normalizationSchemaVersion, 1)
    })))

  it.effect("does not fall back when the declared current entity revision is missing", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()
      const { sql } = yield* Database
      yield* sql`UPDATE entities SET current_revision = 2 WHERE workspace_id = ${WORKSPACE_ID}`

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "RecordNotFoundError")
    })))

  it.effect("does not resolve the same target identity across workspace scope", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()
      const { sql } = yield* Database
      yield* sql`INSERT INTO workspaces (
        workspace_id, display_name, revision, created_at, updated_at
      ) VALUES (${OTHER_WORKSPACE_ID}, 'Other', 1, ${RECORDED_AT}, ${RECORDED_AT})`
      const reader = yield* makeGovernedActionCurrentTargetReader

      const result = yield* reader.read({
        workspaceId: OTHER_WORKSPACE_ID,
        entityId: ENTITY_ID
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "RecordNotFoundError")
    })))

  it.effect("rejects malformed source chronology instead of trusting the current head", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()
      const { sql } = yield* Database
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`UPDATE entity_revisions
        SET first_observed_at = '2026-07-15T10:01:00.000Z'
        WHERE workspace_id = ${WORKSPACE_ID} AND entity_id = ${ENTITY_ID}`
      yield* sql`PRAGMA ignore_check_constraints = OFF`

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(result.failure.diagnosticCode, "current-target-snapshot-invalid")
      }
    })))

  it.effect("rejects a newer projection for an older source revision without fallback", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()
      const { sql } = yield* Database
      yield* sql`INSERT INTO entity_revisions (
        workspace_id, entity_id, revision, source_revision, normalization_schema_version,
        source_url, first_observed_at, last_observed_at, synchronized_at, created_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ENTITY_ID}, 2, 'jira-revision-8', 1,
        'https://jira.example/browse/PAY-42', '2026-07-15T09:56:00.000Z',
        '2026-07-15T09:59:00.000Z', ${RECORDED_AT}, ${RECORDED_AT}
      )`
      yield* sql`UPDATE entities SET current_revision = 2
        WHERE workspace_id = ${WORKSPACE_ID} AND entity_id = ${ENTITY_ID}`
      yield* writeProjection({
        projectionRevision: 2,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: 1
      })

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(result.failure.diagnosticCode, "current-target-projection-mismatch")
      }
    })))

  it.effect("rejects a latest deleted projection", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()
      yield* writeProjection({
        entityState: "deleted",
        projectionRevision: 2,
        supersedesProjectionRevision: 1
      })

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(result.failure.diagnosticCode, "current-target-projection-mismatch")
      }
    })))

  it.effect("rejects a projection whose persisted payload digest was tampered", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      yield* writeProjection()
      const { sql } = yield* Database
      yield* sql`DROP TRIGGER entity_projection_revisions_no_update`
      yield* sql`UPDATE entity_projection_revisions SET extension_digest = ${"f".repeat(64)}
        WHERE workspace_id = ${WORKSPACE_ID} AND entity_id = ${ENTITY_ID}`

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "PersistedRecordError")
    })))

  it.effect("rejects ambiguous current entity rows in a corrupted store", () =>
    withReader(Effect.gen(function*() {
      const { sql } = yield* Database
      yield* sql`ALTER TABLE entities RENAME TO constrained_entities`
      yield* sql`ALTER TABLE entity_revisions RENAME TO constrained_entity_revisions`
      yield* sql`CREATE TABLE entities (
        workspace_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        plugin_connection_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        vendor_immutable_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        current_revision INTEGER NOT NULL
      )`
      yield* sql`CREATE TABLE entity_revisions (
        workspace_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source_revision TEXT NOT NULL,
        normalization_schema_version INTEGER NOT NULL,
        source_url TEXT,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        synchronized_at TEXT NOT NULL
      )`
      yield* sql`INSERT INTO entities (
        workspace_id, entity_id, plugin_connection_id, provider_id,
        vendor_immutable_id, entity_type, current_revision
      ) VALUES
        (${WORKSPACE_ID}, ${ENTITY_ID}, ${CONNECTION_ID}, 'jira', 'PAY-42', 'issue', 1),
        (${WORKSPACE_ID}, ${ENTITY_ID}, ${CONNECTION_ID}, 'jira', 'PAY-42', 'issue', 1)`
      yield* sql`INSERT INTO entity_revisions (
        workspace_id, entity_id, revision, source_revision, normalization_schema_version,
        source_url, first_observed_at, last_observed_at, synchronized_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ENTITY_ID}, 1, 'jira-revision-7', 1,
        'https://jira.example/browse/PAY-42', '2026-07-15T09:55:00.000Z',
        '2026-07-15T09:58:00.000Z', ${RECORDED_AT}
      )`

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(result.failure.diagnosticCode, "current-target-entity-ambiguous")
      }
    })))

  it.effect("rejects ambiguous latest projection rows in a corrupted store", () =>
    withReader(Effect.gen(function*() {
      yield* seedEntity()
      const { sql } = yield* Database
      yield* sql`ALTER TABLE entity_projection_revisions
        RENAME TO constrained_entity_projection_revisions`
      yield* sql`CREATE TABLE entity_projection_revisions (
        workspace_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        projection_revision INTEGER NOT NULL,
        source_entity_revision INTEGER NOT NULL,
        supersedes_projection_revision INTEGER,
        projection_schema_version INTEGER NOT NULL,
        entity_state TEXT NOT NULL,
        display_key TEXT NOT NULL,
        title TEXT NOT NULL,
        extension_json TEXT NOT NULL,
        extension_digest TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )`
      yield* sql`INSERT INTO entity_projection_revisions (
        workspace_id, entity_id, projection_revision, source_entity_revision,
        supersedes_projection_revision, projection_schema_version, entity_state,
        display_key, title, extension_json, extension_digest, recorded_at
      ) VALUES
        (${WORKSPACE_ID}, ${ENTITY_ID}, 1, 1, NULL, 1, 'present',
          'PAY-42', 'Issue', '{}', ${"a".repeat(64)}, ${RECORDED_AT}),
        (${WORKSPACE_ID}, ${ENTITY_ID}, 1, 1, NULL, 1, 'present',
          'PAY-42', 'Issue', '{}', ${"a".repeat(64)}, ${RECORDED_AT})`

      const result = yield* readCurrent.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(result.failure.diagnosticCode, "current-target-projection-ambiguous")
      }
    })))
})
