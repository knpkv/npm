import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { EnvironmentId, type WorkspaceId } from "../../../../domain/identifiers.js"
import type {
  EnvironmentReadinessAssessment,
  ReadinessAssessment,
  ReadinessFactDefinition,
  ReadinessRuleMaterial,
  ReleaseReadinessAssessment
} from "../../../../domain/readiness/index.js"
import { summarizeEnvironmentReadiness } from "../../../../domain/readiness/index.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../Database.js"
import { PersistedRecordError, RevisionConflictError } from "../../errors.js"
import { mapPersistenceOperation, readChanges } from "../internal.js"
import { makeReadinessCodec } from "./codec.js"
import type {
  CommitEnvironmentReadinessAssessmentRequest,
  CommitReleaseReadinessAssessmentRequest,
  ReadCurrentReadinessAssessmentRequest,
  ReadReadinessHistoryRequest
} from "./contract.js"
import { ReadinessHeadRevision, ReadinessInputError } from "./contract.js"
import { makeReadinessMaterialization } from "./materialization.js"
import { captureMalformedReadinessRow } from "./quarantine.js"
import { RawReadinessRow, ReadinessCurrentRow, ReadinessHistoryRow } from "./rows.js"
import { makeReadinessRules } from "./rules.js"

const encodeTimestamp = Schema.encodeSync(UtcTimestamp)
const CurrentRevisionRow = Schema.Struct({
  revision: ReadinessHeadRevision,
  assessmentId: ReadinessCurrentRow.fields.assessmentId
})
const CountRow = Schema.Struct({ count: Schema.Int })
const authorityOf = (pendingCount: number): "authoritative" | "pending" =>
  pendingCount === 0 ? "authoritative" : "pending"

const assessmentColumns = `
  assessment.workspace_id AS workspaceId,
  assessment.assessment_id AS assessmentId,
  assessment.scope_kind AS scopeKind,
  assessment.release_id AS releaseId,
  assessment.environment_id AS environmentId,
  assessment.release_revision AS releaseRevision,
  assessment.artifact_revision AS artifactRevision,
  assessment.candidate_digest AS candidateDigest,
  assessment.rule_id AS ruleId,
  assessment.rule_version AS ruleVersion,
  assessment.rule_digest AS ruleDigest,
  assessment.derivation_version AS derivationVersion,
  assessment.previous_assessment_id AS previousAssessmentId,
  assessment.verdict AS verdict,
  assessment.evaluated_at AS evaluatedAt,
  assessment.next_evaluation_at AS nextEvaluationAt,
  assessment.assessment_json AS assessmentJson,
  assessment.assessment_digest AS assessmentDigest`

const definitionsOf = (assessment: EnvironmentReadinessAssessment) =>
  assessment.facts.map(({ definition }) => definition)

const ruleMatchesAssessment = (
  assessment: ReadinessAssessment,
  definitionsMatch: (material: ReadinessRuleMaterial, definitions: ReadonlyArray<ReadinessFactDefinition>) => boolean,
  material: ReadinessRuleMaterial
): boolean =>
  assessment._tag === "environment"
    ? definitionsMatch(material, definitionsOf(assessment))
    : assessment.environments.every(({ facts }) =>
      definitionsMatch(
        material,
        facts.map(({ definition }) => definition)
      )
    )

export const makeReadinessAssessments = Effect.gen(function*() {
  const database = yield* Database
  const codec = yield* makeReadinessCodec
  const materialization = yield* makeReadinessMaterialization
  const rules = yield* makeReadinessRules
  const sql = database.sql

  const countEnvironmentInvalidations = SqlSchema.findOne({
    Request: Schema.Struct({
      workspaceId: ReadinessCurrentRow.fields.workspaceId,
      releaseId: ReadinessCurrentRow.fields.releaseId,
      environmentId: EnvironmentId
    }),
    Result: CountRow,
    execute: ({ environmentId, releaseId, workspaceId }) =>
      sql`SELECT COUNT(*) AS count FROM readiness_environment_queue
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`
  })

  const countReleaseInvalidations = SqlSchema.findOne({
    Request: Schema.Struct({
      workspaceId: ReadinessCurrentRow.fields.workspaceId,
      releaseId: ReadinessCurrentRow.fields.releaseId
    }),
    Result: CountRow,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT COUNT(*) AS count FROM readiness_release_queue
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
  })

  const countReleaseEnvironmentInvalidations = SqlSchema.findOne({
    Request: Schema.Struct({
      workspaceId: ReadinessCurrentRow.fields.workspaceId,
      releaseId: ReadinessCurrentRow.fields.releaseId
    }),
    Result: CountRow,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT COUNT(*) AS count FROM readiness_environment_queue
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
  })

  const findEnvironmentRevision = SqlSchema.findOneOption({
    Request: Schema.Struct({
      workspaceId: ReadinessCurrentRow.fields.workspaceId,
      releaseId: ReadinessCurrentRow.fields.releaseId,
      environmentId: EnvironmentId
    }),
    Result: CurrentRevisionRow,
    execute: ({ environmentId, releaseId, workspaceId }) =>
      sql`SELECT head_revision AS revision, assessment_id AS assessmentId
          FROM readiness_environment_heads
          WHERE workspace_id = ${workspaceId}
            AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`
  })

  const findReleaseRevision = SqlSchema.findOneOption({
    Request: Schema.Struct({
      workspaceId: ReadinessCurrentRow.fields.workspaceId,
      releaseId: ReadinessCurrentRow.fields.releaseId
    }),
    Result: CurrentRevisionRow,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT head_revision AS revision, assessment_id AS assessmentId
          FROM readiness_release_heads
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
  })

  const verifyExpectedHead = Effect.fn("ReadinessAssessments.verifyExpectedHead")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly recordKey: string
    readonly expected: ReadinessHeadRevision | null
    readonly actual: Option.Option<typeof CurrentRevisionRow.Type>
    readonly previousAssessmentId: ReadinessAssessment["previousAssessmentId"]
  }) {
    const actualRevision = Option.match(input.actual, {
      onNone: () => null,
      onSome: ({ revision }) => revision
    })
    if (actualRevision !== input.expected) {
      return yield* new RevisionConflictError({
        workspaceId: input.workspaceId,
        recordKind: "readiness-head",
        recordKey: input.recordKey,
        expectedRevision: input.expected ?? 0,
        actualRevision
      })
    }
    const actualAssessmentId = Option.match(input.actual, {
      onNone: () => null,
      onSome: ({ assessmentId }) => assessmentId
    })
    if (actualAssessmentId !== input.previousAssessmentId) {
      return yield* new ReadinessInputError({
        operation: input.recordKey.includes(":") ? "commit-environment" : "commit-release",
        reason: "invalid-request"
      })
    }
  })

  const insertAssessment = Effect.fn("ReadinessAssessments.insertAssessment")(function*(input: {
    readonly assessment: ReadinessAssessment
    readonly assessmentJson: string
    readonly assessmentDigest: string
  }) {
    const { assessment } = input
    const environmentId = assessment._tag === "environment" ? assessment.candidate.scope.environmentId : null
    yield* sql`INSERT INTO readiness_assessments (
      workspace_id, assessment_id, scope_kind, release_id, environment_id,
      release_revision, artifact_revision, candidate_digest,
      rule_id, rule_version, rule_digest, derivation_version,
      previous_assessment_id, verdict, evaluated_at, next_evaluation_at,
      assessment_json, assessment_digest
    ) VALUES (
      ${assessment.candidate.workspaceId}, ${assessment.assessmentId}, ${assessment._tag},
      ${assessment.candidate.scope.releaseId}, ${environmentId},
      ${assessment.candidate.releaseRevision}, ${assessment.candidate.artifactRevision},
      ${assessment.candidate.digest}, ${assessment.rule.ruleId}, ${assessment.rule.version},
      ${assessment.rule.digest}, ${assessment.derivationVersion}, ${assessment.previousAssessmentId},
      ${assessment.verdict}, ${encodeTimestamp(assessment.evaluatedAt)},
      ${assessment.nextEvaluationAt === null ? null : encodeTimestamp(assessment.nextEvaluationAt)},
      ${input.assessmentJson}, ${input.assessmentDigest}
    )`
  })

  const materializeAssessment = Effect.fn("ReadinessAssessments.materialize")(function*(input: {
    readonly assessment: ReadinessAssessment
    readonly evidenceIds: ReadonlyArray<string>
    readonly sourcePluginConnectionIds: ReadonlyArray<string>
    readonly releaseChildren: ReadonlyArray<{
      readonly environmentId: string
      readonly environmentAssessmentId: string
      readonly environmentCandidateDigest: string
    }>
  }) {
    const workspaceId = input.assessment.candidate.workspaceId
    yield* Effect.forEach(
      input.evidenceIds,
      (evidenceId) =>
        sql`INSERT INTO readiness_assessment_evidence (
            workspace_id, assessment_id, evidence_id
          ) VALUES (${workspaceId}, ${input.assessment.assessmentId}, ${evidenceId})`,
      { discard: true }
    )
    yield* Effect.forEach(
      input.sourcePluginConnectionIds,
      (pluginConnectionId) =>
        sql`INSERT INTO readiness_assessment_sources (
            workspace_id, assessment_id, plugin_connection_id
          ) VALUES (${workspaceId}, ${input.assessment.assessmentId}, ${pluginConnectionId})`,
      { discard: true }
    )
    yield* Effect.forEach(
      input.releaseChildren,
      (child) =>
        sql`INSERT INTO readiness_release_children (
            workspace_id, release_assessment_id, environment_id,
            environment_assessment_id, environment_candidate_digest
          ) VALUES (
            ${workspaceId}, ${input.assessment.assessmentId}, ${child.environmentId},
            ${child.environmentAssessmentId}, ${child.environmentCandidateDigest}
          )`,
      { discard: true }
    )
  })

  const insertHistory = Effect.fn("ReadinessAssessments.insertHistory")(function*(input: {
    readonly assessment: ReadinessAssessment
    readonly headRevision: ReadinessHeadRevision
    readonly committedAt: UtcTimestamp
  }) {
    const environmentKey = input.assessment._tag === "environment" ? input.assessment.candidate.scope.environmentId : ""
    yield* sql`INSERT INTO readiness_head_history (
      workspace_id, scope_kind, release_id, environment_key,
      head_revision, assessment_id, committed_at
    ) VALUES (
      ${input.assessment.candidate.workspaceId}, ${input.assessment._tag},
      ${input.assessment.candidate.scope.releaseId}, ${environmentKey},
      ${input.headRevision}, ${input.assessment.assessmentId}, ${encodeTimestamp(input.committedAt)}
    )`
  })

  const publishEnvironmentHead = Effect.fn("ReadinessAssessments.publishEnvironmentHead")(function*(input: {
    readonly assessment: EnvironmentReadinessAssessment
    readonly expected: ReadinessHeadRevision | null
    readonly headRevision: ReadinessHeadRevision
    readonly committedAt: UtcTimestamp
  }) {
    const assessment = input.assessment
    const timestamp = encodeTimestamp(input.committedAt)
    if (input.expected === null) {
      yield* sql`INSERT INTO readiness_environment_heads (
        workspace_id, release_id, environment_id, head_revision, assessment_id,
        candidate_digest, rule_id, rule_version, rule_digest, derivation_version,
        created_at, updated_at
      ) VALUES (
        ${assessment.candidate.workspaceId}, ${assessment.candidate.scope.releaseId},
        ${assessment.candidate.scope.environmentId}, ${input.headRevision}, ${assessment.assessmentId},
        ${assessment.candidate.digest}, ${assessment.rule.ruleId}, ${assessment.rule.version},
        ${assessment.rule.digest}, ${assessment.derivationVersion}, ${timestamp}, ${timestamp}
      )`.pipe(mapPersistenceOperation("readiness.insert-environment-head"))
    } else {
      // The schedule FK names the exact current assessment, so remove it inside
      // the same transaction before advancing the mutable head.
      yield* sql`DELETE FROM readiness_evaluation_schedules
        WHERE workspace_id = ${assessment.candidate.workspaceId}
          AND release_id = ${assessment.candidate.scope.releaseId}
          AND environment_id = ${assessment.candidate.scope.environmentId}`
      yield* sql`UPDATE readiness_environment_heads
        SET head_revision = ${input.headRevision}, assessment_id = ${assessment.assessmentId},
            candidate_digest = ${assessment.candidate.digest}, rule_id = ${assessment.rule.ruleId},
            rule_version = ${assessment.rule.version}, rule_digest = ${assessment.rule.digest},
            derivation_version = ${assessment.derivationVersion}, updated_at = ${timestamp}
        WHERE workspace_id = ${assessment.candidate.workspaceId}
          AND release_id = ${assessment.candidate.scope.releaseId}
          AND environment_id = ${assessment.candidate.scope.environmentId}
          AND head_revision = ${input.expected}`
      if ((yield* readChanges(sql)) === 0) {
        const actual = yield* findEnvironmentRevision({
          workspaceId: assessment.candidate.workspaceId,
          releaseId: assessment.candidate.scope.releaseId,
          environmentId: assessment.candidate.scope.environmentId
        })
        return yield* new RevisionConflictError({
          workspaceId: assessment.candidate.workspaceId,
          recordKind: "readiness-head",
          recordKey: `${assessment.candidate.scope.releaseId}:${assessment.candidate.scope.environmentId}`,
          expectedRevision: input.expected,
          actualRevision: Option.match(actual, { onNone: () => null, onSome: ({ revision }) => revision })
        })
      }
    }
    if (assessment.nextEvaluationAt === null) {
      yield* sql`DELETE FROM readiness_evaluation_schedules
        WHERE workspace_id = ${assessment.candidate.workspaceId}
          AND release_id = ${assessment.candidate.scope.releaseId}
          AND environment_id = ${assessment.candidate.scope.environmentId}`
    } else {
      yield* sql`INSERT INTO readiness_evaluation_schedules (
        workspace_id, release_id, environment_id, assessment_id, due_at
      ) VALUES (
        ${assessment.candidate.workspaceId}, ${assessment.candidate.scope.releaseId},
        ${assessment.candidate.scope.environmentId}, ${assessment.assessmentId},
        ${encodeTimestamp(assessment.nextEvaluationAt)}
      ) ON CONFLICT (workspace_id, release_id, environment_id) DO UPDATE SET
        assessment_id = excluded.assessment_id, due_at = excluded.due_at`.pipe(
        mapPersistenceOperation("readiness.upsert-schedule")
      )
    }
    yield* sql`INSERT INTO readiness_release_queue (
      workspace_id, release_id, invalidation_revision, reason, source_environment_id,
      queued_at, available_at, attempts, claim_owner, claim_token, claim_expires_at
    ) VALUES (
      ${assessment.candidate.workspaceId}, ${assessment.candidate.scope.releaseId}, 1,
      'environment-assessment-changed', ${assessment.candidate.scope.environmentId},
      ${timestamp}, ${timestamp}, 0, NULL, NULL, NULL
    ) ON CONFLICT (workspace_id, release_id) DO UPDATE SET
      invalidation_revision = readiness_release_queue.invalidation_revision + 1,
      reason = excluded.reason, source_environment_id = excluded.source_environment_id,
      queued_at = excluded.queued_at, available_at = excluded.available_at,
      claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL`.pipe(
      mapPersistenceOperation("readiness.enqueue-release-after-environment")
    )
  })

  const publishReleaseHead = Effect.fn("ReadinessAssessments.publishReleaseHead")(function*(input: {
    readonly assessment: ReleaseReadinessAssessment
    readonly expected: ReadinessHeadRevision | null
    readonly headRevision: ReadinessHeadRevision
    readonly committedAt: UtcTimestamp
  }) {
    const assessment = input.assessment
    const timestamp = encodeTimestamp(input.committedAt)
    if (input.expected === null) {
      yield* sql`INSERT INTO readiness_release_heads (
        workspace_id, release_id, head_revision, assessment_id, candidate_digest,
        rule_id, rule_version, rule_digest, derivation_version, created_at, updated_at
      ) VALUES (
        ${assessment.candidate.workspaceId}, ${assessment.candidate.scope.releaseId},
        ${input.headRevision}, ${assessment.assessmentId}, ${assessment.candidate.digest},
        ${assessment.rule.ruleId}, ${assessment.rule.version}, ${assessment.rule.digest},
        ${assessment.derivationVersion}, ${timestamp}, ${timestamp}
      )`
    } else {
      yield* sql`UPDATE readiness_release_heads
        SET head_revision = ${input.headRevision}, assessment_id = ${assessment.assessmentId},
            candidate_digest = ${assessment.candidate.digest}, rule_id = ${assessment.rule.ruleId},
            rule_version = ${assessment.rule.version}, rule_digest = ${assessment.rule.digest},
            derivation_version = ${assessment.derivationVersion}, updated_at = ${timestamp}
        WHERE workspace_id = ${assessment.candidate.workspaceId}
          AND release_id = ${assessment.candidate.scope.releaseId}
          AND head_revision = ${input.expected}`
      if ((yield* readChanges(sql)) === 0) {
        const actual = yield* findReleaseRevision({
          workspaceId: assessment.candidate.workspaceId,
          releaseId: assessment.candidate.scope.releaseId
        })
        return yield* new RevisionConflictError({
          workspaceId: assessment.candidate.workspaceId,
          recordKind: "readiness-head",
          recordKey: assessment.candidate.scope.releaseId,
          expectedRevision: input.expected,
          actualRevision: Option.match(actual, { onNone: () => null, onSome: ({ revision }) => revision })
        })
      }
    }
  })

  const prepareCommit = Effect.fn("ReadinessAssessments.prepareCommit")(function*(
    assessment: ReadinessAssessment,
    operation: "commit-environment" | "commit-release"
  ) {
    const prepared = yield* codec.prepareAssessment(assessment)
    if (prepared.computedCandidateDigest !== assessment.candidate.digest) {
      return yield* new ReadinessInputError({ operation, reason: "candidate-digest-mismatch" })
    }
    const rule = yield* rules.loadRule({
      workspaceId: assessment.candidate.workspaceId,
      ruleId: assessment.rule.ruleId,
      ruleVersion: assessment.rule.version
    })
    if (rule.row.ruleDigest !== assessment.rule.digest) {
      return yield* new ReadinessInputError({ operation, reason: "rule-digest-mismatch" })
    }
    if (!ruleMatchesAssessment(assessment, rules.definitionsMatch, rule.material)) {
      return yield* new ReadinessInputError({ operation, reason: "rule-definition-mismatch" })
    }
    return prepared
  })

  const consumeEnvironmentInvalidation = Effect.fn("ReadinessAssessments.consumeEnvironmentInvalidation")(
    function*(request: CommitEnvironmentReadinessAssessmentRequest) {
      const assessment = request.assessment
      if (request.invalidation === null) {
        const { count } = yield* countEnvironmentInvalidations({
          workspaceId: assessment.candidate.workspaceId,
          releaseId: assessment.candidate.scope.releaseId,
          environmentId: assessment.candidate.scope.environmentId
        })
        if (count === 0) return
      } else {
        const now = encodeTimestamp(yield* DateTime.now)
        yield* sql`DELETE FROM readiness_environment_queue
          WHERE workspace_id = ${assessment.candidate.workspaceId}
            AND release_id = ${assessment.candidate.scope.releaseId}
            AND environment_id = ${assessment.candidate.scope.environmentId}
            AND invalidation_revision = ${request.invalidation.invalidationRevision}
            AND claim_owner = ${request.invalidation.leaseOwner}
            AND claim_token = ${request.invalidation.leaseToken}
            AND claim_expires_at > ${now}`
        if ((yield* readChanges(sql)) === 1) return
      }
      return yield* new ReadinessInputError({
        operation: "commit-environment",
        reason: "stale-invalidation"
      })
    }
  )

  const consumeReleaseInvalidation = Effect.fn("ReadinessAssessments.consumeReleaseInvalidation")(
    function*(request: CommitReleaseReadinessAssessmentRequest) {
      const assessment = request.assessment
      const { count: pendingEnvironmentCount } = yield* countReleaseEnvironmentInvalidations({
        workspaceId: assessment.candidate.workspaceId,
        releaseId: assessment.candidate.scope.releaseId
      })
      if (pendingEnvironmentCount > 0) {
        return yield* new ReadinessInputError({ operation: "commit-release", reason: "stale-invalidation" })
      }
      if (request.invalidation === null) {
        const { count } = yield* countReleaseInvalidations({
          workspaceId: assessment.candidate.workspaceId,
          releaseId: assessment.candidate.scope.releaseId
        })
        if (count === 0) return
      } else {
        const now = encodeTimestamp(yield* DateTime.now)
        yield* sql`DELETE FROM readiness_release_queue
          WHERE workspace_id = ${assessment.candidate.workspaceId}
            AND release_id = ${assessment.candidate.scope.releaseId}
            AND invalidation_revision = ${request.invalidation.invalidationRevision}
            AND claim_owner = ${request.invalidation.leaseOwner}
            AND claim_token = ${request.invalidation.leaseToken}
            AND claim_expires_at > ${now}`
        if ((yield* readChanges(sql)) === 1) return
      }
      return yield* new ReadinessInputError({ operation: "commit-release", reason: "stale-invalidation" })
    }
  )

  const verifyReleaseChildren = Effect.fn("ReadinessAssessments.verifyReleaseChildren")(function*(
    assessment: ReleaseReadinessAssessment
  ) {
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: RawReadinessRow,
      execute: () =>
        sql.unsafe(
          `SELECT 1 AS headRevision, assessment.evaluated_at AS committedAt,
            ${assessmentColumns}
          FROM readiness_environment_heads head
          INNER JOIN readiness_assessments assessment
            ON assessment.workspace_id = head.workspace_id
           AND assessment.assessment_id = head.assessment_id
          INNER JOIN release_targets target
            ON target.workspace_id = head.workspace_id
           AND target.release_id = head.release_id
           AND target.environment_id = head.environment_id
           AND target.lifecycle_kind = 'active'
          WHERE head.workspace_id = ? AND head.release_id = ?
          ORDER BY head.environment_id`,
          [assessment.candidate.workspaceId, assessment.candidate.scope.releaseId]
        )
    })(undefined)
    const decodedChildren = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function*() {
        const decodedRow = yield* Schema.decodeUnknownEffect(ReadinessHistoryRow)(row).pipe(
          Effect.mapError(() =>
            new PersistedRecordError({
              workspaceId: assessment.candidate.workspaceId,
              recordKind: "readiness-assessment",
              recordKey: assessment.candidate.scope.releaseId,
              diagnosticCode: "readiness-assessment-schema-invalid"
            })
          ),
          captureMalformedReadinessRow(row)
        )
        const current = yield* codec.decodeAssessmentRow(decodedRow).pipe(captureMalformedReadinessRow(row))
        return { current, row }
      }))
    const groupedMaterialization = yield* materialization.load({
      workspaceId: assessment.candidate.workspaceId,
      assessmentIds: decodedChildren.map(({ current }) => current.assessmentId)
    })
    const currentSummaries = yield* Effect.forEach(decodedChildren, ({ current, row }) =>
      Effect.gen(function*() {
        yield* materialization.verify(current, row, groupedMaterialization)
        return current._tag === "environment"
          ? summarizeEnvironmentReadiness(current)
          : yield* new ReadinessInputError({ operation: "commit-release", reason: "invalid-request" })
      }))
    const matches = currentSummaries.length === assessment.environments.length &&
      currentSummaries.every((summary, index) => {
        const supplied: ReleaseReadinessAssessment["environments"][number] | undefined = assessment.environments[index]
        return supplied !== undefined && JSON.stringify(summary) === JSON.stringify(supplied)
      })
    if (!matches) {
      return yield* new ReadinessInputError({ operation: "commit-release", reason: "invalid-request" })
    }
  })

  const commitEnvironment = Effect.fn("ReadinessAssessments.commitEnvironment")(function*(
    request: CommitEnvironmentReadinessAssessmentRequest
  ) {
    const assessment = request.assessment
    const committedAt = yield* DateTime.now
    if (DateTime.Order(assessment.evaluatedAt, committedAt) > 0) {
      return yield* new ReadinessInputError({ operation: "commit-environment", reason: "invalid-request" })
    }
    const current = yield* findEnvironmentRevision({
      workspaceId: assessment.candidate.workspaceId,
      releaseId: assessment.candidate.scope.releaseId,
      environmentId: assessment.candidate.scope.environmentId
    })
    yield* verifyExpectedHead({
      workspaceId: assessment.candidate.workspaceId,
      recordKey: `${assessment.candidate.scope.releaseId}:${assessment.candidate.scope.environmentId}`,
      expected: request.expectedHeadRevision,
      actual: current,
      previousAssessmentId: assessment.previousAssessmentId
    })
    const prepared = yield* prepareCommit(assessment, "commit-environment")
    const headRevision = ReadinessHeadRevision.make((request.expectedHeadRevision ?? 0) + 1)
    yield* insertAssessment({ assessment, ...prepared }).pipe(mapPersistenceOperation("readiness.insert-assessment"))
    yield* materializeAssessment({ assessment, ...prepared }).pipe(
      mapPersistenceOperation("readiness.materialize-assessment")
    )
    yield* insertHistory({ assessment, headRevision, committedAt }).pipe(
      mapPersistenceOperation("readiness.insert-head-history")
    )
    yield* publishEnvironmentHead({
      assessment,
      expected: request.expectedHeadRevision,
      headRevision,
      committedAt
    }).pipe(mapPersistenceOperation("readiness.publish-environment-head"))
    yield* consumeEnvironmentInvalidation(request)
    return { assessment, headRevision, committedAt }
  })

  const commitRelease = Effect.fn("ReadinessAssessments.commitRelease")(function*(
    request: CommitReleaseReadinessAssessmentRequest
  ) {
    const assessment = request.assessment
    const committedAt = yield* DateTime.now
    if (DateTime.Order(assessment.evaluatedAt, committedAt) > 0) {
      return yield* new ReadinessInputError({ operation: "commit-release", reason: "invalid-request" })
    }
    const current = yield* findReleaseRevision({
      workspaceId: assessment.candidate.workspaceId,
      releaseId: assessment.candidate.scope.releaseId
    })
    yield* verifyExpectedHead({
      workspaceId: assessment.candidate.workspaceId,
      recordKey: assessment.candidate.scope.releaseId,
      expected: request.expectedHeadRevision,
      actual: current,
      previousAssessmentId: assessment.previousAssessmentId
    })
    yield* verifyReleaseChildren(assessment)
    const prepared = yield* prepareCommit(assessment, "commit-release")
    const headRevision = ReadinessHeadRevision.make((request.expectedHeadRevision ?? 0) + 1)
    yield* insertAssessment({ assessment, ...prepared })
    yield* materializeAssessment({ assessment, ...prepared })
    yield* insertHistory({ assessment, headRevision, committedAt })
    yield* publishReleaseHead({
      assessment,
      expected: request.expectedHeadRevision,
      headRevision,
      committedAt
    })
    yield* consumeReleaseInvalidation(request)
    return { assessment, headRevision, committedAt }
  })

  const currentRows = (request: ReadCurrentReadinessAssessmentRequest) => {
    const environmentKey = request._tag === "environment" ? request.environmentId : ""
    const headTable = request._tag === "environment" ? "readiness_environment_heads" : "readiness_release_heads"
    const environmentPredicate = request._tag === "environment" ? "AND head.environment_id = ?" : ""
    const pendingExpression = request._tag === "environment"
      ? `EXISTS (
          SELECT 1 FROM readiness_environment_queue pending
          WHERE pending.workspace_id = head.workspace_id
            AND pending.release_id = head.release_id
            AND pending.environment_id = head.environment_id
        )`
      : `EXISTS (
          SELECT 1 FROM readiness_release_queue pending
          WHERE pending.workspace_id = head.workspace_id
            AND pending.release_id = head.release_id
        ) OR EXISTS (
          SELECT 1 FROM readiness_environment_queue pending_environment
          WHERE pending_environment.workspace_id = head.workspace_id
            AND pending_environment.release_id = head.release_id
        )`
    const parameters = request._tag === "environment"
      ? [request._tag, environmentKey, request.workspaceId, request.releaseId, request.environmentId]
      : [request._tag, environmentKey, request.workspaceId, request.releaseId]
    return SqlSchema.findAll({
      Request: Schema.Void,
      Result: RawReadinessRow,
      execute: () =>
        sql.unsafe(
          `SELECT
          CASE WHEN history.assessment_id IS NOT NULL AND assessment.assessment_id IS NOT NULL
            THEN 1 ELSE 0 END AS joinComplete,
          head.workspace_id AS headWorkspaceId,
          head.release_id AS headReleaseId,
          ${request._tag === "environment" ? "head.environment_id" : "NULL"} AS headEnvironmentId,
          head.assessment_id AS headAssessmentId,
          head.updated_at AS headUpdatedAt,
          history.head_revision AS headRevision,
          head.head_revision AS currentHeadRevision,
          history.committed_at AS committedAt,
          CASE WHEN ${pendingExpression} THEN 1 ELSE 0 END AS pendingCount,
          ${assessmentColumns},
          head.candidate_digest AS headCandidateDigest,
          head.rule_id AS headRuleId,
          head.rule_version AS headRuleVersion,
          head.rule_digest AS headRuleDigest,
          head.derivation_version AS headDerivationVersion
        FROM ${headTable} head
        LEFT JOIN readiness_head_history history
          ON history.workspace_id = head.workspace_id
         AND history.assessment_id = head.assessment_id
         AND history.scope_kind = ?
         AND history.release_id = head.release_id
         AND history.environment_key = ?
         AND history.head_revision = head.head_revision
        LEFT JOIN readiness_assessments assessment
          ON assessment.workspace_id = head.workspace_id
         AND assessment.assessment_id = head.assessment_id
        WHERE head.workspace_id = ? AND head.release_id = ? ${environmentPredicate}`,
          parameters
        )
    })(undefined)
  }

  const historyRows = (request: ReadReadinessHistoryRequest) => {
    const environmentKey = request._tag === "environment" ? request.environmentId : ""
    return SqlSchema.findAll({
      Request: Schema.Void,
      Result: RawReadinessRow,
      execute: () =>
        sql.unsafe(
          `SELECT
          CASE WHEN assessment.assessment_id IS NOT NULL THEN 1 ELSE 0 END AS joinComplete,
          history.head_revision AS headRevision,
          history.committed_at AS committedAt,
          ${assessmentColumns}
        FROM readiness_head_history history
        LEFT JOIN readiness_assessments assessment
          ON assessment.workspace_id = history.workspace_id
         AND assessment.assessment_id = history.assessment_id
        WHERE history.workspace_id = ?
          AND history.scope_kind = ?
          AND history.release_id = ?
          AND history.environment_key = ?
          AND (? IS NULL OR history.head_revision < ?)
        ORDER BY history.head_revision DESC
        LIMIT ?`,
          [
            request.workspaceId,
            request._tag,
            request.releaseId,
            environmentKey,
            request.beforeHeadRevision,
            request.beforeHeadRevision,
            request.limit + 1
          ]
        )
    })(undefined)
  }

  const decodeCurrentRow = Effect.fn("ReadinessAssessments.decodeCurrentRow")(function*(
    row: typeof RawReadinessRow.Type,
    request: ReadCurrentReadinessAssessmentRequest
  ) {
    const recordKind = request._tag === "environment" ? "readiness-environment-head" : "readiness-release-head"
    const recordKey = request._tag === "environment" ? request.environmentId : request.releaseId
    const malformedHead = (diagnosticCode: string) =>
      new PersistedRecordError({ workspaceId: request.workspaceId, recordKind, recordKey, diagnosticCode })
    if (!Predicate.hasProperty(row, "joinComplete") || row.joinComplete !== 1) {
      return yield* captureMalformedReadinessRow(row)(
        Effect.fail(malformedHead("readiness-head-assessment-mismatch"))
      )
    }
    const decodedRow = yield* Schema.decodeUnknownEffect(ReadinessCurrentRow)(row).pipe(
      Effect.mapError(() =>
        malformedHead(
          request._tag === "environment"
            ? "readiness-environment-head-schema-invalid"
            : "readiness-release-head-schema-invalid"
        )
      ),
      captureMalformedReadinessRow(row)
    )
    const assessment = yield* codec.decodeAssessmentRow(decodedRow).pipe(captureMalformedReadinessRow(row))
    if (
      decodedRow.headWorkspaceId !== request.workspaceId ||
      decodedRow.headReleaseId !== request.releaseId ||
      (request._tag === "environment"
        ? decodedRow.headEnvironmentId !== request.environmentId
        : decodedRow.headEnvironmentId !== null) ||
      decodedRow.headAssessmentId !== decodedRow.assessmentId ||
      decodedRow.workspaceId !== decodedRow.headWorkspaceId ||
      decodedRow.releaseId !== decodedRow.headReleaseId ||
      decodedRow.scopeKind !== request._tag ||
      (request._tag === "environment"
        ? decodedRow.environmentId !== request.environmentId
        : decodedRow.environmentId !== null) ||
      decodedRow.headCandidateDigest !== decodedRow.candidateDigest ||
      decodedRow.currentHeadRevision !== decodedRow.headRevision ||
      decodedRow.headRuleId !== decodedRow.ruleId ||
      decodedRow.headRuleVersion !== decodedRow.ruleVersion ||
      decodedRow.headRuleDigest !== decodedRow.ruleDigest ||
      decodedRow.headDerivationVersion !== decodedRow.derivationVersion ||
      decodedRow.headUpdatedAt !== decodedRow.committedAt
    ) {
      return yield* captureMalformedReadinessRow(row)(
        Effect.fail(malformedHead("readiness-head-assessment-mismatch"))
      )
    }
    const committedAt = yield* Schema.decodeUnknownEffect(UtcTimestamp)(decodedRow.committedAt).pipe(
      Effect.mapError(() =>
        malformedHead(
          request._tag === "environment"
            ? "readiness-environment-head-schema-invalid"
            : "readiness-release-head-schema-invalid"
        )
      ),
      captureMalformedReadinessRow(row)
    )
    return {
      assessment,
      headRevision: ReadinessHeadRevision.make(decodedRow.headRevision),
      committedAt,
      authority: authorityOf(decodedRow.pendingCount)
    }
  })

  const decodeHistoryRow = Effect.fn("ReadinessAssessments.decodeHistoryRow")(function*(
    row: typeof RawReadinessRow.Type,
    request: ReadReadinessHistoryRequest
  ) {
    const recordKey = request._tag === "environment" ? request.environmentId : request.releaseId
    const malformed = (diagnosticCode: string) =>
      new PersistedRecordError({
        workspaceId: request.workspaceId,
        recordKind: "readiness-assessment",
        recordKey,
        diagnosticCode
      })
    if (!Predicate.hasProperty(row, "joinComplete") || row.joinComplete !== 1) {
      return yield* captureMalformedReadinessRow(row)(
        Effect.fail(malformed("readiness-assessment-identity-mismatch"))
      )
    }
    const decodedRow = yield* Schema.decodeUnknownEffect(ReadinessHistoryRow)(row).pipe(
      Effect.mapError(() => malformed("readiness-assessment-schema-invalid")),
      captureMalformedReadinessRow(row)
    )
    const assessment = yield* codec.decodeAssessmentRow(decodedRow).pipe(captureMalformedReadinessRow(row))
    const identityMatches = decodedRow.workspaceId === request.workspaceId &&
      decodedRow.releaseId === request.releaseId &&
      decodedRow.scopeKind === request._tag &&
      (request._tag === "environment"
        ? decodedRow.environmentId === request.environmentId
        : decodedRow.environmentId === null)
    if (!identityMatches) {
      return yield* captureMalformedReadinessRow(row)(
        Effect.fail(malformed("readiness-assessment-identity-mismatch"))
      )
    }
    const committedAt = yield* Schema.decodeUnknownEffect(UtcTimestamp)(decodedRow.committedAt).pipe(
      Effect.mapError(() => malformed("readiness-assessment-schema-invalid")),
      captureMalformedReadinessRow(row)
    )
    return {
      assessment,
      headRevision: ReadinessHeadRevision.make(decodedRow.headRevision),
      committedAt
    }
  })

  return {
    commitEnvironment,
    commitRelease,
    currentRows,
    decodeCurrentRow,
    decodeHistoryRow,
    historyRows,
    loadAssessmentMaterialization: materialization.load,
    verifyAssessmentMaterialization: materialization.verify
  }
})
