import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-300000000001"
const releaseId = "01890f6f-6d6a-7cc0-98d2-300000000002"
const environmentId = "01890f6f-6d6a-7cc0-98d2-300000000003"
const otherEnvironmentId = "01890f6f-6d6a-7cc0-98d2-300000000009"
const firstAssessmentId = "01890f6f-6d6a-7cc0-98d2-300000000004"
const secondAssessmentId = "01890f6f-6d6a-7cc0-98d2-300000000005"
const staleReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-300000000006"
const currentReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-300000000007"
const mismatchedReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-300000000008"
const otherEnvironmentAssessmentId = "01890f6f-6d6a-7cc0-98d2-30000000000a"
const skippedAssessmentId = "01890f6f-6d6a-7cc0-98d2-30000000000b"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-30000000000c"
const otherPluginConnectionId = "01890f6f-6d6a-7cc0-98d2-30000000000d"
const currentRevisionAssessmentId = "01890f6f-6d6a-7cc0-98d2-30000000000e"
const endedTargetAssessmentId = "01890f6f-6d6a-7cc0-98d2-30000000000f"
const endedOmittedReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-300000000010"
const ruleDigest = `sha256:${"a".repeat(64)}`
const firstCandidateDigest = `sha256:${"b".repeat(64)}`
const secondCandidateDigest = `sha256:${"c".repeat(64)}`
const releaseCandidateDigest = `sha256:${"d".repeat(64)}`
const otherEnvironmentCandidateDigest = `sha256:${"e".repeat(64)}`
const recordedAt = "2026-07-15T10:00:00.000Z"

const releaseAssessmentJson = (
  environments: ReadonlyArray<{
    readonly assessmentId: string
    readonly candidateDigest: string
    readonly environmentId: string
  }>
) => JSON.stringify({ environments, evidenceIds: [], sourceFreshness: [] })

const seedRelease = Effect.fn("ReadinessMigrationTest.seedRelease")(function*() {
  const database = yield* Database
  const sql = database.sql
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${workspaceId}, 'Readiness', 1, ${recordedAt}, ${recordedAt})`
  yield* sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES (${workspaceId}, ${releaseId}, 1, ${recordedAt}, ${recordedAt})`
  yield* sql`INSERT INTO release_revisions (
    workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
  ) VALUES (
    ${workspaceId}, ${releaseId}, 1, '{}', ${"0".repeat(64)}, ${recordedAt}
  )`
  yield* sql`INSERT INTO release_targets (
    workspace_id, release_id, environment_id, created_at
  ) VALUES (${workspaceId}, ${releaseId}, ${environmentId}, ${recordedAt})`
  yield* sql`INSERT INTO readiness_rule_snapshots (
    workspace_id, rule_id, rule_version, rule_digest, material_json, created_at
  ) VALUES (${workspaceId}, 'delivery-v1', 1, ${ruleDigest}, '{}', ${recordedAt})`
  yield* sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES
    (${workspaceId}, ${pluginConnectionId}, 'jira', 'Jira', 1, 1, ${recordedAt}, ${recordedAt}),
    (${workspaceId}, ${otherPluginConnectionId}, 'confluence', 'Confluence', 1, 1,
      ${recordedAt}, ${recordedAt})`
})

const insertAssessment = Effect.fn("ReadinessMigrationTest.insertAssessment")(function*(input: {
  readonly artifactRevision?: string
  readonly assessmentId: string
  readonly candidateDigest: string
  readonly environment: boolean
  readonly environmentId?: string
  readonly evaluatedAt: string
  readonly nextEvaluationAt?: string
  readonly previousAssessmentId?: string
  readonly releaseRevision?: number
  readonly assessmentJson?: string
}) {
  const database = yield* Database
  yield* database.sql`INSERT INTO readiness_assessments (
    workspace_id, assessment_id, scope_kind, release_id, environment_id,
    release_revision, artifact_revision, candidate_digest,
    rule_id, rule_version, rule_digest, derivation_version,
    previous_assessment_id, verdict, evaluated_at, next_evaluation_at,
    assessment_json, assessment_digest
  ) VALUES (
    ${workspaceId}, ${input.assessmentId}, ${input.environment ? "environment" : "release"},
    ${releaseId}, ${input.environment ? input.environmentId ?? environmentId : null},
    ${input.releaseRevision ?? 1},
    ${input.artifactRevision ?? "git:abc123"}, ${input.candidateDigest},
    'delivery-v1', 1, ${ruleDigest}, 1, ${input.previousAssessmentId ?? null},
    'ready', ${input.evaluatedAt}, ${input.nextEvaluationAt ?? null},
    ${input.assessmentJson ?? "{\"evidenceIds\":[],\"sourceFreshness\":[]}"}, ${"1".repeat(64)}
  )`
})

const insertHeadHistory = Effect.fn("ReadinessMigrationTest.insertHeadHistory")(function*(input: {
  readonly assessmentId: string
  readonly committedAt: string
  readonly environmentId?: string
  readonly headRevision: number
  readonly scopeKind: "environment" | "release"
}) {
  const database = yield* Database
  yield* database.sql`INSERT INTO readiness_head_history (
    workspace_id, scope_kind, release_id, environment_key,
    head_revision, assessment_id, committed_at
  ) VALUES (
    ${workspaceId}, ${input.scopeKind}, ${releaseId}, ${input.environmentId ?? ""},
    ${input.headRevision}, ${input.assessmentId}, ${input.committedAt}
  )`
})

describe("readiness migration invariants", () => {
  it.effect("retains immutable audit history and permits only exact head advancement", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-migration-")
      yield* Effect.gen(function*() {
        const database = yield* Database
        const sql = database.sql
        yield* seedRelease()
        yield* insertAssessment({
          assessmentId: firstAssessmentId,
          assessmentJson: JSON.stringify({
            evidenceIds: [],
            sourceFreshness: [{ pluginConnectionId }]
          }),
          candidateDigest: firstCandidateDigest,
          environment: true,
          evaluatedAt: recordedAt
        })
        const invalidInitialRevision = yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, 2, ${firstAssessmentId},
          ${firstCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, ${recordedAt}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(invalidInitialRevision))
        const missingDependency = yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, 1, ${firstAssessmentId},
          ${firstCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, ${recordedAt}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(missingDependency))
        yield* sql`INSERT INTO readiness_assessment_sources (
          workspace_id, assessment_id, plugin_connection_id
        ) VALUES (${workspaceId}, ${firstAssessmentId}, ${pluginConnectionId})`
        yield* insertHeadHistory({
          assessmentId: firstAssessmentId,
          committedAt: recordedAt,
          environmentId,
          headRevision: 1,
          scopeKind: "environment"
        })
        yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, 1, ${firstAssessmentId},
          ${firstCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, ${recordedAt}
        )`

        yield* insertAssessment({
          assessmentId: secondAssessmentId,
          candidateDigest: secondCandidateDigest,
          environment: true,
          evaluatedAt: "2026-07-15T10:05:00.000Z",
          nextEvaluationAt: "2026-07-15T11:00:00.000Z",
          previousAssessmentId: firstAssessmentId
        })
        yield* insertAssessment({
          assessmentId: skippedAssessmentId,
          candidateDigest: `sha256:${"f".repeat(64)}`,
          environment: true,
          evaluatedAt: "2026-07-15T10:06:00.000Z",
          previousAssessmentId: secondAssessmentId
        })

        const skippedChain = yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${skippedAssessmentId},
            candidate_digest = ${`sha256:${"f".repeat(64)}`}, updated_at = '2026-07-15T10:06:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(skippedChain))
        const postPublicationDependency = yield* sql`INSERT INTO readiness_assessment_sources (
          workspace_id, assessment_id, plugin_connection_id
        ) VALUES (${workspaceId}, ${firstAssessmentId}, ${otherPluginConnectionId})`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(postPublicationDependency))

        const skippedRevision = yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 3, assessment_id = ${secondAssessmentId},
            candidate_digest = ${secondCandidateDigest}, updated_at = '2026-07-15T10:05:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(skippedRevision))

        yield* insertHeadHistory({
          assessmentId: secondAssessmentId,
          committedAt: "2026-07-15T10:05:00.000Z",
          environmentId,
          headRevision: 2,
          scopeKind: "environment"
        })
        yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${secondAssessmentId},
            candidate_digest = ${secondCandidateDigest}, updated_at = '2026-07-15T10:05:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`

        const assessmentMutation = yield* sql`UPDATE readiness_assessments
          SET verdict = 'blocked'
          WHERE workspace_id = ${workspaceId} AND assessment_id = ${firstAssessmentId}`.pipe(Effect.result)
        const ruleMutation = yield* sql`UPDATE readiness_rule_snapshots
          SET material_json = '{"changed":true}'
          WHERE workspace_id = ${workspaceId} AND rule_id = 'delivery-v1' AND rule_version = 1`.pipe(
          Effect.result
        )
        assert.isTrue(Result.isFailure(assessmentMutation))
        assert.isTrue(Result.isFailure(ruleMutation))

        const staleSchedule = yield* sql`INSERT INTO readiness_evaluation_schedules (
          workspace_id, release_id, environment_id, assessment_id, due_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, ${firstAssessmentId},
          '2026-07-15T11:00:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleSchedule))
        const earlySchedule = yield* sql`INSERT INTO readiness_evaluation_schedules (
          workspace_id, release_id, environment_id, assessment_id, due_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, ${secondAssessmentId},
          '2026-07-15T10:59:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(earlySchedule))
        yield* sql`INSERT INTO readiness_evaluation_schedules (
          workspace_id, release_id, environment_id, assessment_id, due_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, ${secondAssessmentId},
          '2026-07-15T11:00:00.000Z'
        )`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects stale or candidate-mismatched release children", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-children-")
      yield* Effect.gen(function*() {
        const database = yield* Database
        const sql = database.sql
        yield* seedRelease()
        yield* insertAssessment({
          assessmentId: firstAssessmentId,
          candidateDigest: firstCandidateDigest,
          environment: true,
          evaluatedAt: recordedAt
        })
        yield* insertAssessment({
          assessmentId: secondAssessmentId,
          candidateDigest: secondCandidateDigest,
          environment: true,
          evaluatedAt: "2026-07-15T10:05:00.000Z",
          previousAssessmentId: firstAssessmentId
        })
        yield* insertHeadHistory({
          assessmentId: firstAssessmentId,
          committedAt: recordedAt,
          environmentId,
          headRevision: 1,
          scopeKind: "environment"
        })
        yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, 1, ${firstAssessmentId},
          ${firstCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, ${recordedAt}
        )`
        yield* insertHeadHistory({
          assessmentId: secondAssessmentId,
          committedAt: "2026-07-15T10:05:00.000Z",
          environmentId,
          headRevision: 2,
          scopeKind: "environment"
        })
        yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${secondAssessmentId},
            candidate_digest = ${secondCandidateDigest}, updated_at = '2026-07-15T10:05:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`
        yield* sql`INSERT INTO release_targets (
          workspace_id, release_id, environment_id, created_at
        ) VALUES (${workspaceId}, ${releaseId}, ${otherEnvironmentId}, ${recordedAt})`
        yield* insertAssessment({
          assessmentId: otherEnvironmentAssessmentId,
          candidateDigest: otherEnvironmentCandidateDigest,
          environment: true,
          environmentId: otherEnvironmentId,
          evaluatedAt: "2026-07-15T10:05:00.000Z"
        })
        yield* insertHeadHistory({
          assessmentId: otherEnvironmentAssessmentId,
          committedAt: "2026-07-15T10:05:00.000Z",
          environmentId: otherEnvironmentId,
          headRevision: 1,
          scopeKind: "environment"
        })
        yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${otherEnvironmentId}, 1, ${otherEnvironmentAssessmentId},
          ${otherEnvironmentCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, '2026-07-15T10:05:00.000Z'
        )`
        yield* insertAssessment({
          assessmentId: staleReleaseAssessmentId,
          assessmentJson: releaseAssessmentJson([{
            assessmentId: firstAssessmentId,
            candidateDigest: firstCandidateDigest,
            environmentId
          }]),
          candidateDigest: releaseCandidateDigest,
          environment: false,
          evaluatedAt: "2026-07-15T10:10:00.000Z"
        })
        yield* sql`INSERT INTO readiness_release_children (
          workspace_id, release_assessment_id, environment_id,
          environment_assessment_id, environment_candidate_digest
        ) VALUES (
          ${workspaceId}, ${staleReleaseAssessmentId}, ${environmentId},
          ${firstAssessmentId}, ${firstCandidateDigest}
        )`
        const staleReleaseHead = yield* sql`INSERT INTO readiness_release_heads (
          workspace_id, release_id, head_revision, assessment_id, candidate_digest,
          rule_id, rule_version, rule_digest, derivation_version, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, 1, ${staleReleaseAssessmentId}, ${releaseCandidateDigest},
          'delivery-v1', 1, ${ruleDigest}, 1, ${recordedAt}, '2026-07-15T10:10:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleReleaseHead))

        yield* insertAssessment({
          assessmentId: mismatchedReleaseAssessmentId,
          artifactRevision: "git:different",
          assessmentJson: releaseAssessmentJson([{
            assessmentId: secondAssessmentId,
            candidateDigest: secondCandidateDigest,
            environmentId
          }]),
          candidateDigest: releaseCandidateDigest,
          environment: false,
          evaluatedAt: "2026-07-15T10:10:00.000Z"
        })
        const mismatchedChild = yield* sql`INSERT INTO readiness_release_children (
          workspace_id, release_assessment_id, environment_id,
          environment_assessment_id, environment_candidate_digest
        ) VALUES (
          ${workspaceId}, ${mismatchedReleaseAssessmentId}, ${environmentId},
          ${secondAssessmentId}, ${secondCandidateDigest}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedChild))

        yield* insertAssessment({
          assessmentId: currentReleaseAssessmentId,
          assessmentJson: releaseAssessmentJson([
            {
              assessmentId: secondAssessmentId,
              candidateDigest: secondCandidateDigest,
              environmentId
            },
            {
              assessmentId: otherEnvironmentAssessmentId,
              candidateDigest: otherEnvironmentCandidateDigest,
              environmentId: otherEnvironmentId
            }
          ]),
          candidateDigest: releaseCandidateDigest,
          environment: false,
          evaluatedAt: "2026-07-15T10:10:00.000Z"
        })
        yield* sql`INSERT INTO readiness_release_children (
          workspace_id, release_assessment_id, environment_id,
          environment_assessment_id, environment_candidate_digest
        ) VALUES (
          ${workspaceId}, ${currentReleaseAssessmentId}, ${environmentId},
          ${secondAssessmentId}, ${secondCandidateDigest}
        )`
        const incompleteReleaseHead = yield* sql`INSERT INTO readiness_release_heads (
          workspace_id, release_id, head_revision, assessment_id, candidate_digest,
          rule_id, rule_version, rule_digest, derivation_version, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, 1, ${currentReleaseAssessmentId}, ${releaseCandidateDigest},
          'delivery-v1', 1, ${ruleDigest}, 1, ${recordedAt}, '2026-07-15T10:10:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(incompleteReleaseHead))
        yield* sql`INSERT INTO readiness_release_children (
          workspace_id, release_assessment_id, environment_id,
          environment_assessment_id, environment_candidate_digest
        ) VALUES (
          ${workspaceId}, ${currentReleaseAssessmentId}, ${otherEnvironmentId},
          ${otherEnvironmentAssessmentId}, ${otherEnvironmentCandidateDigest}
        )`
        const invalidInitialReleaseRevision = yield* sql`INSERT INTO readiness_release_heads (
          workspace_id, release_id, head_revision, assessment_id, candidate_digest,
          rule_id, rule_version, rule_digest, derivation_version, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, 2, ${currentReleaseAssessmentId}, ${releaseCandidateDigest},
          'delivery-v1', 1, ${ruleDigest}, 1, ${recordedAt}, '2026-07-15T10:10:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(invalidInitialReleaseRevision))
        yield* insertHeadHistory({
          assessmentId: currentReleaseAssessmentId,
          committedAt: "2026-07-15T10:10:00.000Z",
          headRevision: 1,
          scopeKind: "release"
        })
        yield* sql`INSERT INTO readiness_release_heads (
          workspace_id, release_id, head_revision, assessment_id, candidate_digest,
          rule_id, rule_version, rule_digest, derivation_version, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, 1, ${currentReleaseAssessmentId}, ${releaseCandidateDigest},
          'delivery-v1', 1, ${ruleDigest}, 1, ${recordedAt}, '2026-07-15T10:10:00.000Z'
        )`
        const heads = yield* sql<{ readonly assessmentId: string }>`SELECT
          assessment_id AS assessmentId FROM readiness_release_heads`
        assert.deepStrictEqual(heads, [{ assessmentId: currentReleaseAssessmentId }])

        yield* sql`UPDATE release_targets
          SET lifecycle_kind = 'ended', ended_at = '2026-07-15T10:11:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${otherEnvironmentId}`
        yield* insertAssessment({
          assessmentId: endedOmittedReleaseAssessmentId,
          assessmentJson: releaseAssessmentJson([{
            assessmentId: secondAssessmentId,
            candidateDigest: secondCandidateDigest,
            environmentId
          }]),
          candidateDigest: `sha256:${"f".repeat(64)}`,
          environment: false,
          evaluatedAt: "2026-07-15T10:12:00.000Z",
          previousAssessmentId: currentReleaseAssessmentId
        })
        yield* sql`INSERT INTO readiness_release_children (
          workspace_id, release_assessment_id, environment_id,
          environment_assessment_id, environment_candidate_digest
        ) VALUES (
          ${workspaceId}, ${endedOmittedReleaseAssessmentId}, ${environmentId},
          ${secondAssessmentId}, ${secondCandidateDigest}
        )`
        yield* insertHeadHistory({
          assessmentId: endedOmittedReleaseAssessmentId,
          committedAt: "2026-07-15T10:12:00.000Z",
          headRevision: 2,
          scopeKind: "release"
        })
        yield* sql`UPDATE readiness_release_heads
          SET head_revision = 2, assessment_id = ${endedOmittedReleaseAssessmentId},
            candidate_digest = ${`sha256:${"f".repeat(64)}`}, updated_at = '2026-07-15T10:12:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("publishes only the current release revision and active targets", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-readiness-current-")
      yield* Effect.gen(function*() {
        const database = yield* Database
        const sql = database.sql
        yield* seedRelease()
        yield* insertAssessment({
          assessmentId: firstAssessmentId,
          candidateDigest: firstCandidateDigest,
          environment: true,
          evaluatedAt: recordedAt
        })
        yield* sql`INSERT INTO release_revisions (
          workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, 2, '{}', ${"2".repeat(64)}, '2026-07-15T10:05:00.000Z'
        )`
        yield* sql`UPDATE releases SET current_revision = 2, updated_at = '2026-07-15T10:05:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
        const staleRevision = yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, 1, ${firstAssessmentId},
          ${firstCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, ${recordedAt}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleRevision))

        yield* insertAssessment({
          assessmentId: currentRevisionAssessmentId,
          candidateDigest: secondCandidateDigest,
          environment: true,
          evaluatedAt: "2026-07-15T10:05:00.000Z",
          releaseRevision: 2
        })
        yield* insertHeadHistory({
          assessmentId: currentRevisionAssessmentId,
          committedAt: "2026-07-15T10:05:00.000Z",
          environmentId,
          headRevision: 1,
          scopeKind: "environment"
        })
        yield* sql`INSERT INTO readiness_environment_heads (
          workspace_id, release_id, environment_id, head_revision, assessment_id,
          candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
          created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${releaseId}, ${environmentId}, 1, ${currentRevisionAssessmentId},
          ${secondCandidateDigest}, 'delivery-v1', 1, ${ruleDigest}, 1,
          ${recordedAt}, '2026-07-15T10:05:00.000Z'
        )`
        yield* sql`UPDATE release_targets
          SET lifecycle_kind = 'ended', ended_at = '2026-07-15T10:06:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`
        yield* insertAssessment({
          assessmentId: endedTargetAssessmentId,
          candidateDigest: `sha256:${"f".repeat(64)}`,
          environment: true,
          evaluatedAt: "2026-07-15T10:07:00.000Z",
          previousAssessmentId: currentRevisionAssessmentId,
          releaseRevision: 2
        })
        const endedAdvance = yield* sql`UPDATE readiness_environment_heads
          SET head_revision = 2, assessment_id = ${endedTargetAssessmentId},
            candidate_digest = ${`sha256:${"f".repeat(64)}`}, updated_at = '2026-07-15T10:07:00.000Z'
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(endedAdvance))
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
