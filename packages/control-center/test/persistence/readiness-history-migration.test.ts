import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { migration0001Core } from "../../src/server/persistence/migrations/0001_core.js"
import { migration0002Integrity } from "../../src/server/persistence/migrations/0002_integrity.js"
import { migration0003Auth } from "../../src/server/persistence/migrations/0003_auth.js"
import { migration0004PluginRuntime } from "../../src/server/persistence/migrations/0004_plugin_runtime.js"
import { migration0005PluginConfiguration } from "../../src/server/persistence/migrations/0005_plugin_configuration.js"
import { migration0006PluginSyncPageEvidence } from "../../src/server/persistence/migrations/0006_plugin_sync_page_evidence.js"
import { migration0007DomainEvents } from "../../src/server/persistence/migrations/0007_domain_events.js"
import { migration0008DeliveryGraph } from "../../src/server/persistence/migrations/0008_delivery_graph.js"
import { migration0009Readiness } from "../../src/server/persistence/migrations/0009_readiness.js"
import { MIGRATION_LEDGER_TABLE, migrationLoader } from "../../src/server/persistence/migrations/index.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-310000000001"
const RELEASE_ID = "01890f6f-6d6a-7cc0-98d2-310000000002"
const ENVIRONMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000003"
const OTHER_ENVIRONMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000004"
const FIRST_ASSESSMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000005"
const SECOND_ASSESSMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000006"
const OTHER_ASSESSMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000007"
const FIRST_RELEASE_ASSESSMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000008"
const SECOND_RELEASE_ASSESSMENT_ID = "01890f6f-6d6a-7cc0-98d2-310000000009"
const RULE_DIGEST = `sha256:${"a".repeat(64)}`
const FIRST_CANDIDATE_DIGEST = `sha256:${"b".repeat(64)}`
const SECOND_CANDIDATE_DIGEST = `sha256:${"c".repeat(64)}`
const OTHER_CANDIDATE_DIGEST = `sha256:${"d".repeat(64)}`
const FIRST_RELEASE_CANDIDATE_DIGEST = `sha256:${"e".repeat(64)}`
const SECOND_RELEASE_CANDIDATE_DIGEST = `sha256:${"f".repeat(64)}`
const RECORDED_AT = "2026-07-15T10:00:00.000Z"
const SECOND_RECORDED_AT = "2026-07-15T10:05:00.000Z"
const ASSESSMENT_JSON = "{\"evidenceIds\":[],\"sourceFreshness\":[]}"

const versionNineLoader = LibsqlMigrator.fromRecord({
  "0001_core_heads": migration0001Core,
  "0002_integrity_blobs": migration0002Integrity,
  "0003_auth": migration0003Auth,
  "0004_plugin_runtime": migration0004PluginRuntime,
  "0005_plugin_configuration": migration0005PluginConfiguration,
  "0006_plugin_sync_page_evidence": migration0006PluginSyncPageEvidence,
  "0007_domain_events": migration0007DomainEvents,
  "0008_delivery_graph": migration0008DeliveryGraph,
  "0009_readiness": migration0009Readiness
})

interface AssessmentFixture {
  readonly assessmentId: string
  readonly candidateDigest: string
  readonly environmentId: string
  readonly evaluatedAt: string
  readonly previousAssessmentId: string | null
}

interface ReleaseAssessmentFixture {
  readonly assessmentId: string
  readonly candidateDigest: string
  readonly environmentAssessmentId: string
  readonly environmentCandidateDigest: string
  readonly evaluatedAt: string
  readonly previousAssessmentId: string | null
}

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase())

const runVersionNineMigrations = (sql: SqlClient.SqlClient) =>
  LibsqlMigrator.run({ loader: versionNineLoader, table: MIGRATION_LEDGER_TABLE }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql)
  )

const runCurrentMigrations = (sql: SqlClient.SqlClient) =>
  LibsqlMigrator.run({ loader: migrationLoader, table: MIGRATION_LEDGER_TABLE }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql)
  )

const seedRelease = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`INSERT INTO workspaces (
      workspace_id, display_name, revision, created_at, updated_at
    ) VALUES (${WORKSPACE_ID}, 'History upgrade', 1, ${RECORDED_AT}, ${RECORDED_AT})`
    yield* sql`INSERT INTO releases (
      workspace_id, release_id, current_revision, created_at, updated_at
    ) VALUES (${WORKSPACE_ID}, ${RELEASE_ID}, 1, ${RECORDED_AT}, ${RECORDED_AT})`
    yield* sql`INSERT INTO release_revisions (
      workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
    ) VALUES (${WORKSPACE_ID}, ${RELEASE_ID}, 1, '{}', ${"0".repeat(64)}, ${RECORDED_AT})`
    yield* sql`INSERT INTO release_targets (
      workspace_id, release_id, environment_id, created_at
    ) VALUES (${WORKSPACE_ID}, ${RELEASE_ID}, ${ENVIRONMENT_ID}, ${RECORDED_AT})`
    yield* sql`INSERT INTO readiness_rule_snapshots (
      workspace_id, rule_id, rule_version, rule_digest, material_json, created_at
    ) VALUES (${WORKSPACE_ID}, 'delivery-v1', 1, ${RULE_DIGEST}, '{}', ${RECORDED_AT})`
  })

const insertAssessment = (sql: SqlClient.SqlClient, fixture: AssessmentFixture) =>
  sql`INSERT INTO readiness_assessments (
    workspace_id, assessment_id, scope_kind, release_id, environment_id,
    release_revision, artifact_revision, candidate_digest,
    rule_id, rule_version, rule_digest, derivation_version,
    previous_assessment_id, verdict, evaluated_at, next_evaluation_at,
    assessment_json, assessment_digest
  ) VALUES (
    ${WORKSPACE_ID}, ${fixture.assessmentId}, 'environment', ${RELEASE_ID},
    ${fixture.environmentId}, 1, 'git:abc123', ${fixture.candidateDigest},
    'delivery-v1', 1, ${RULE_DIGEST}, 1, ${fixture.previousAssessmentId},
    'ready', ${fixture.evaluatedAt}, NULL, ${ASSESSMENT_JSON}, ${"1".repeat(64)}
  )`

const insertEnvironmentHead = (
  sql: SqlClient.SqlClient,
  fixture: AssessmentFixture
) =>
  sql`INSERT INTO readiness_environment_heads (
    workspace_id, release_id, environment_id, head_revision, assessment_id,
    candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
    created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${RELEASE_ID}, ${fixture.environmentId}, 1, ${fixture.assessmentId},
    ${fixture.candidateDigest}, 'delivery-v1', 1, ${RULE_DIGEST}, 1,
    ${fixture.evaluatedAt}, ${fixture.evaluatedAt}
  )`

const insertReleaseAssessment = (
  sql: SqlClient.SqlClient,
  fixture: ReleaseAssessmentFixture
) =>
  Effect.gen(function*() {
    const assessmentJson = JSON.stringify({
      environments: [{
        assessmentId: fixture.environmentAssessmentId,
        candidateDigest: fixture.environmentCandidateDigest,
        environmentId: ENVIRONMENT_ID
      }],
      evidenceIds: [],
      sourceFreshness: []
    })
    yield* sql`INSERT INTO readiness_assessments (
      workspace_id, assessment_id, scope_kind, release_id, environment_id,
      release_revision, artifact_revision, candidate_digest,
      rule_id, rule_version, rule_digest, derivation_version,
      previous_assessment_id, verdict, evaluated_at, next_evaluation_at,
      assessment_json, assessment_digest
    ) VALUES (
      ${WORKSPACE_ID}, ${fixture.assessmentId}, 'release', ${RELEASE_ID}, NULL,
      1, 'git:abc123', ${fixture.candidateDigest},
      'delivery-v1', 1, ${RULE_DIGEST}, 1, ${fixture.previousAssessmentId},
      'ready', ${fixture.evaluatedAt}, NULL, ${assessmentJson}, ${"2".repeat(64)}
    )`
    yield* sql`INSERT INTO readiness_release_children (
      workspace_id, release_assessment_id, environment_id,
      environment_assessment_id, environment_candidate_digest
    ) VALUES (
      ${WORKSPACE_ID}, ${fixture.assessmentId}, ${ENVIRONMENT_ID},
      ${fixture.environmentAssessmentId}, ${fixture.environmentCandidateDigest}
    )`
  })

const insertReleaseHead = (
  sql: SqlClient.SqlClient,
  fixture: ReleaseAssessmentFixture
) =>
  sql`INSERT INTO readiness_release_heads (
    workspace_id, release_id, head_revision, assessment_id, candidate_digest,
    rule_id, rule_version, rule_digest, derivation_version, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${RELEASE_ID}, 1, ${fixture.assessmentId}, ${fixture.candidateDigest},
    'delivery-v1', 1, ${RULE_DIGEST}, 1, ${fixture.evaluatedAt}, ${fixture.evaluatedAt}
  )`

const firstAssessment: AssessmentFixture = {
  assessmentId: FIRST_ASSESSMENT_ID,
  candidateDigest: FIRST_CANDIDATE_DIGEST,
  environmentId: ENVIRONMENT_ID,
  evaluatedAt: RECORDED_AT,
  previousAssessmentId: null
}

const secondAssessment: AssessmentFixture = {
  assessmentId: SECOND_ASSESSMENT_ID,
  candidateDigest: SECOND_CANDIDATE_DIGEST,
  environmentId: ENVIRONMENT_ID,
  evaluatedAt: SECOND_RECORDED_AT,
  previousAssessmentId: FIRST_ASSESSMENT_ID
}

const firstReleaseAssessment: ReleaseAssessmentFixture = {
  assessmentId: FIRST_RELEASE_ASSESSMENT_ID,
  candidateDigest: FIRST_RELEASE_CANDIDATE_DIGEST,
  environmentAssessmentId: FIRST_ASSESSMENT_ID,
  environmentCandidateDigest: FIRST_CANDIDATE_DIGEST,
  evaluatedAt: RECORDED_AT,
  previousAssessmentId: null
}

const secondReleaseAssessment: ReleaseAssessmentFixture = {
  assessmentId: SECOND_RELEASE_ASSESSMENT_ID,
  candidateDigest: SECOND_RELEASE_CANDIDATE_DIGEST,
  environmentAssessmentId: SECOND_ASSESSMENT_ID,
  environmentCandidateDigest: SECOND_CANDIDATE_DIGEST,
  evaluatedAt: SECOND_RECORDED_AT,
  previousAssessmentId: FIRST_RELEASE_ASSESSMENT_ID
}

const clientLayer = (databaseUrl: string) =>
  LibsqlClient.layer({ transformResultNames: snakeToCamel, url: databaseUrl })

describe("readiness head history upgrade", () => {
  it.effect("upgrades an empty version 9 database without inventing history", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-history-empty-")
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* runVersionNineMigrations(sql)
        yield* runCurrentMigrations(sql)

        const history = yield* sql`SELECT assessment_id FROM readiness_head_history`
        assert.deepStrictEqual(history, [])
      }).pipe(Effect.provide(clientLayer(config.databaseUrl)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("fences legacy claims and enforces complete lease tuples", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-history-leases-")
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* runVersionNineMigrations(sql)
        yield* seedRelease(sql)
        yield* sql`INSERT INTO readiness_environment_queue (
          workspace_id, release_id, environment_id, invalidation_revision, reason,
          queued_at, available_at, attempts, claim_owner, claim_expires_at
        ) VALUES (
          ${WORKSPACE_ID}, ${RELEASE_ID}, ${ENVIRONMENT_ID}, 1, 'candidate-changed',
          ${RECORDED_AT}, ${RECORDED_AT}, 1, 'legacy-environment-worker', '2099-01-01T00:00:00.000Z'
        )`
        yield* sql`INSERT INTO readiness_release_queue (
          workspace_id, release_id, invalidation_revision, reason,
          queued_at, available_at, attempts, claim_owner, claim_expires_at
        ) VALUES (
          ${WORKSPACE_ID}, ${RELEASE_ID}, 1, 'candidate-changed',
          ${RECORDED_AT}, ${RECORDED_AT}, 1, 'legacy-release-worker', '2099-01-01T00:00:00.000Z'
        )`
        yield* runCurrentMigrations(sql)

        const environment = yield* sql<{
          readonly claimExpiresAt: string | null
          readonly claimOwner: string | null
          readonly claimToken: string | null
        }>`SELECT claim_owner AS claimOwner, claim_token AS claimToken,
                   claim_expires_at AS claimExpiresAt
            FROM readiness_environment_queue`
        const release = yield* sql<{
          readonly claimExpiresAt: string | null
          readonly claimOwner: string | null
          readonly claimToken: string | null
        }>`SELECT claim_owner AS claimOwner, claim_token AS claimToken,
                   claim_expires_at AS claimExpiresAt
            FROM readiness_release_queue`
        assert.deepStrictEqual(environment, [{ claimOwner: null, claimToken: null, claimExpiresAt: null }])
        assert.deepStrictEqual(release, [{ claimOwner: null, claimToken: null, claimExpiresAt: null }])

        const partial = yield* sql`UPDATE readiness_environment_queue
          SET claim_owner = 'partial-worker', claim_expires_at = '2026-07-15T10:15:00.000Z'
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}
            AND environment_id = ${ENVIRONMENT_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(partial))
        const partialRelease = yield* sql`UPDATE readiness_release_queue
          SET claim_token = 'orphan-token'
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(partialRelease))
        yield* sql`UPDATE readiness_environment_queue
          SET claim_owner = 'current-worker', claim_token = 'current-token',
              claim_expires_at = '2026-07-15T10:15:00.000Z'
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}
            AND environment_id = ${ENVIRONMENT_ID}`
        yield* sql`UPDATE readiness_environment_queue
          SET claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}
            AND environment_id = ${ENVIRONMENT_ID}`
      }).pipe(Effect.provide(clientLayer(config.databaseUrl)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a version 9 head above revision one instead of truncating history", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-history-reject-")
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* runVersionNineMigrations(sql)
        yield* seedRelease(sql)
        yield* insertAssessment(sql, firstAssessment)
        yield* insertEnvironmentHead(sql, firstAssessment)
        yield* insertAssessment(sql, secondAssessment)
        yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${SECOND_ASSESSMENT_ID},
            candidate_digest = ${SECOND_CANDIDATE_DIGEST}, updated_at = ${SECOND_RECORDED_AT}
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}
            AND environment_id = ${ENVIRONMENT_ID}`

        const outcome = yield* runCurrentMigrations(sql).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(outcome))
        if (Exit.isFailure(outcome)) {
          assert.include(
            Cause.pretty(outcome.cause),
            "cannot truthfully reconstruct a version 9 head above revision 1"
          )
        }
        const historyTables = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'readiness_head_history'`
        const ledger = yield* sql<{ readonly migrationId: number }>`SELECT
          migration_id AS migrationId FROM ${sql(MIGRATION_LEDGER_TABLE)} ORDER BY migration_id`
        assert.deepStrictEqual(historyTables, [])
        assert.deepStrictEqual(ledger.map(({ migrationId }) => migrationId), [1, 2, 3, 4, 5, 6, 7, 8, 9])
      }).pipe(Effect.provide(clientLayer(config.databaseUrl)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("upgrades revision one and requires exact history for later head writes", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-history-current-")
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* runVersionNineMigrations(sql)
        yield* seedRelease(sql)
        yield* insertAssessment(sql, firstAssessment)
        yield* insertEnvironmentHead(sql, firstAssessment)
        yield* runCurrentMigrations(sql)

        yield* insertReleaseAssessment(sql, firstReleaseAssessment)
        const unrecordedReleaseInsert = yield* insertReleaseHead(sql, firstReleaseAssessment).pipe(
          Effect.result
        )
        assert.isTrue(Result.isFailure(unrecordedReleaseInsert))
        yield* sql`INSERT INTO readiness_head_history (
          workspace_id, scope_kind, release_id, environment_key,
          head_revision, assessment_id, committed_at
        ) VALUES (
          ${WORKSPACE_ID}, 'release', ${RELEASE_ID}, '',
          1, ${FIRST_RELEASE_ASSESSMENT_ID}, ${RECORDED_AT}
        )`
        yield* insertReleaseHead(sql, firstReleaseAssessment)

        yield* insertAssessment(sql, secondAssessment)
        const unrecordedAdvance = yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${SECOND_ASSESSMENT_ID},
            candidate_digest = ${SECOND_CANDIDATE_DIGEST}, updated_at = ${SECOND_RECORDED_AT}
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}
            AND environment_id = ${ENVIRONMENT_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(unrecordedAdvance))

        yield* sql`INSERT INTO readiness_head_history (
          workspace_id, scope_kind, release_id, environment_key,
          head_revision, assessment_id, committed_at
        ) VALUES (
          ${WORKSPACE_ID}, 'environment', ${RELEASE_ID}, ${ENVIRONMENT_ID},
          2, ${SECOND_ASSESSMENT_ID}, ${SECOND_RECORDED_AT}
        )`
        yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${SECOND_ASSESSMENT_ID},
            candidate_digest = ${SECOND_CANDIDATE_DIGEST}, updated_at = ${SECOND_RECORDED_AT}
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}
            AND environment_id = ${ENVIRONMENT_ID}`

        yield* insertReleaseAssessment(sql, secondReleaseAssessment)
        const unrecordedReleaseAdvance = yield* sql`UPDATE readiness_release_heads
          SET head_revision = 2, assessment_id = ${SECOND_RELEASE_ASSESSMENT_ID},
            candidate_digest = ${SECOND_RELEASE_CANDIDATE_DIGEST},
            updated_at = ${SECOND_RECORDED_AT}
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(unrecordedReleaseAdvance))
        yield* sql`INSERT INTO readiness_head_history (
          workspace_id, scope_kind, release_id, environment_key,
          head_revision, assessment_id, committed_at
        ) VALUES (
          ${WORKSPACE_ID}, 'release', ${RELEASE_ID}, '',
          2, ${SECOND_RELEASE_ASSESSMENT_ID}, ${SECOND_RECORDED_AT}
        )`
        yield* sql`UPDATE readiness_release_heads
          SET head_revision = 2, assessment_id = ${SECOND_RELEASE_ASSESSMENT_ID},
            candidate_digest = ${SECOND_RELEASE_CANDIDATE_DIGEST},
            updated_at = ${SECOND_RECORDED_AT}
          WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}`

        yield* sql`INSERT INTO release_targets (
          workspace_id, release_id, environment_id, created_at
        ) VALUES (${WORKSPACE_ID}, ${RELEASE_ID}, ${OTHER_ENVIRONMENT_ID}, ${RECORDED_AT})`
        const otherAssessment: AssessmentFixture = {
          assessmentId: OTHER_ASSESSMENT_ID,
          candidateDigest: OTHER_CANDIDATE_DIGEST,
          environmentId: OTHER_ENVIRONMENT_ID,
          evaluatedAt: SECOND_RECORDED_AT,
          previousAssessmentId: null
        }
        yield* insertAssessment(sql, otherAssessment)
        const unrecordedInsert = yield* insertEnvironmentHead(sql, otherAssessment).pipe(Effect.result)
        assert.isTrue(Result.isFailure(unrecordedInsert))
        yield* sql`INSERT INTO readiness_head_history (
          workspace_id, scope_kind, release_id, environment_key,
          head_revision, assessment_id, committed_at
        ) VALUES (
          ${WORKSPACE_ID}, 'environment', ${RELEASE_ID}, ${OTHER_ENVIRONMENT_ID},
          1, ${OTHER_ASSESSMENT_ID}, ${SECOND_RECORDED_AT}
        )`
        yield* insertEnvironmentHead(sql, otherAssessment)

        const history = yield* sql<{
          readonly assessmentId: string
          readonly environmentKey: string
          readonly headRevision: number
        }>`SELECT assessment_id AS assessmentId, environment_key AS environmentKey,
            head_revision AS headRevision
          FROM readiness_head_history
          ORDER BY scope_kind, environment_key, head_revision`
        assert.deepStrictEqual(history, [
          {
            assessmentId: FIRST_ASSESSMENT_ID,
            environmentKey: ENVIRONMENT_ID,
            headRevision: 1
          },
          {
            assessmentId: SECOND_ASSESSMENT_ID,
            environmentKey: ENVIRONMENT_ID,
            headRevision: 2
          },
          {
            assessmentId: OTHER_ASSESSMENT_ID,
            environmentKey: OTHER_ENVIRONMENT_ID,
            headRevision: 1
          },
          {
            assessmentId: FIRST_RELEASE_ASSESSMENT_ID,
            environmentKey: "",
            headRevision: 1
          },
          {
            assessmentId: SECOND_RELEASE_ASSESSMENT_ID,
            environmentKey: "",
            headRevision: 2
          }
        ])

        const historyTriggers = yield* sql<{ readonly name: string }>`SELECT name
          FROM sqlite_master
          WHERE type = 'trigger' AND name IN (
            'readiness_environment_heads_history_insert',
            'readiness_environment_heads_history_update',
            'readiness_release_heads_history_insert',
            'readiness_release_heads_history_update'
          ) ORDER BY name`
        assert.deepStrictEqual(historyTriggers.map(({ name }) => name), [
          "readiness_environment_heads_history_insert",
          "readiness_environment_heads_history_update",
          "readiness_release_heads_history_insert",
          "readiness_release_heads_history_update"
        ])
      }).pipe(Effect.provide(clientLayer(config.databaseUrl)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
